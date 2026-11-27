import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { logger } from 'firebase-functions/logger';
import {
  onTaskDispatched,
  type TaskQueueFunction,
  type TaskQueueOptions,
} from 'firebase-functions/v2/tasks';
import { GenkitError } from 'genkit';
import type { Agent, AgentInit, AgentInput, AgentOutput } from 'genkit/beta';
import { CLAIM_WAIT_MS, RENEW_INTERVAL_MS, WORKER_LEASE_MS } from './detach.js';
import { type DetachedTurns, detachedTurnsConfig } from './detached-turns.js';
import {
  type FinishStatus,
  FirestoreRunStore,
  type RunError,
  type RunStore,
  refreshClaims,
  userCheckFailure,
} from './runs.js';
import type { AgentAuthContext, TurnLock } from './types.js';

/** The worker aborts its turn this long before its deadline. */
export const SELF_ABORT_MARGIN_MS = 20_000;
/**
 * The worker aborts its turn when no renewal succeeded for this long, which
 * leaves one renew interval and a margin before the lease runs out.
 */
export const RENEW_GIVE_UP_MS = WORKER_LEASE_MS - RENEW_INTERVAL_MS - 10_000;
/** A run created longer ago than this has no turn route waiting for it. */
export const STALE_RUN_MS = CLAIM_WAIT_MS + 10_000;

/** The task payload: the id of the run to execute. */
export interface AgentTaskData {
  runId: string;
}

/** What the worker needs from the agent. */
export interface TaskAgent {
  /** Runs the turn detached and resolves with its output. */
  runTurn(
    input: AgentInput,
    init: AgentInit | undefined,
    context: AgentAuthContext,
  ): Promise<AgentOutput>;
  /** Asks the detached turn to stop. */
  abort(snapshotId: string, context: AgentAuthContext): Promise<unknown>;
  /** Resolves once the detached turn's snapshot settles. */
  waitForSettled(
    snapshotId: string,
    context: AgentAuthContext,
  ): Promise<{ status?: string; finishReason?: string } | undefined>;
}

/** The seams of {@link runDetachedTask}. */
export interface WorkerDeps {
  runs: RunStore;
  lock: TurnLock;
  agent: TaskAgent;
  /** The user, or `undefined` when it no longer exists. */
  getUser(
    uid: string,
  ): Promise<
    | Pick<UserRecord, 'disabled' | 'tokensValidAfterTime' | 'customClaims'>
    | undefined
  >;
  instanceId: string | null;
  timeoutSeconds: number;
  now(): number;
}

function toRunError(err: unknown): RunError {
  if (err instanceof GenkitError) {
    return { status: err.status, message: err.originalMessage };
  }
  return { status: 'INTERNAL', message: 'Internal error' };
}

/**
 * Executes one detached run: claims it, confirms the lock and the user, runs
 * the turn, records its output and waits until it settles. The lock lease is
 * renewed while the turn runs, until the worker deadline. The turn is aborted
 * when a renewal finds the lock lost, when renewals keep failing, shortly
 * before the deadline, when the turn route gave up on it, and when waiting
 * for it fails. Such a run ends `aborted` (`cancelled` when the turn route
 * gave up). The lock is released at the end.
 */
export async function runDetachedTask(
  runId: string,
  deps: WorkerDeps,
): Promise<void> {
  const { runs, lock, agent } = deps;
  const startedAt = deps.now();
  const deadline = startedAt + deps.timeoutSeconds * 1000;
  const claimed = await runs.claim(
    runId,
    deps.instanceId,
    startedAt,
    STALE_RUN_MS,
  );
  if (typeof claimed === 'string') {
    logger.warn(`Refused detached run ${runId}: ${claimed}.`);
    return;
  }
  if ('stale' in claimed) {
    logger.warn(`Cancelled detached run ${runId}: it waited too long.`);
    await lock.release(claimed.lockKey, runId);
    return;
  }
  const { uid, lockKey } = claimed;
  let lockHeld = false;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotId: string | undefined;
  let context: AgentAuthContext | undefined;
  const stopRenewing = () => {
    clearInterval(renewTimer);
    renewTimer = undefined;
  };
  try {
    lockHeld = await lock
      .renew(lockKey, runId, WORKER_LEASE_MS)
      .catch(() => false);
    if (!lockHeld) {
      await runs.finish(
        runId,
        'cancelled',
        {
          error: {
            status: 'ABORTED',
            message: 'The session lock was lost before the turn started.',
          },
        },
        deps.now(),
      );
      return;
    }
    const user = await deps.getUser(uid);
    const failure = userCheckFailure(user, claimed.claims);
    if (failure || !user) {
      await runs.finish(runId, 'cancelled', { error: failure }, deps.now());
      return;
    }
    const turnContext: AgentAuthContext = {
      auth: { uid, token: refreshClaims(claimed.claims, user.customClaims) },
    };
    context = turnContext;

    let stopReason: string | undefined;
    const abortTurn = () => {
      if (!snapshotId) return;
      agent.abort(snapshotId, turnContext).catch((err: unknown) => {
        logger.error(`Failed to abort detached run ${runId}`, err);
      });
    };
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      logger.warn(`Stopping detached run ${runId}: ${reason}.`);
      abortTurn();
    };
    let lastRenewed = deps.now();
    renewTimer = setInterval(() => {
      if (deps.now() >= deadline) {
        stopRenewing();
        return;
      }
      lock.renew(lockKey, runId, WORKER_LEASE_MS).then(
        (ok) => {
          if (ok) lastRenewed = deps.now();
          else stop('the session lock was lost');
        },
        (err: unknown) => {
          logger.warn(`Failed to renew the lock of run ${runId}`, err);
          if (deps.now() - lastRenewed > RENEW_GIVE_UP_MS) {
            stop('the session lock could not be renewed');
          }
        },
      );
    }, RENEW_INTERVAL_MS);
    deadlineTimer = setTimeout(
      () => {
        stopRenewing();
        stop('the worker deadline is near');
      },
      deadline - SELF_ABORT_MARGIN_MS - deps.now(),
    );

    let output: AgentOutput;
    try {
      output = await agent.runTurn(
        claimed.input,
        claimed.init ?? undefined,
        turnContext,
      );
    } catch (err) {
      await runs.finish(
        runId,
        'failed',
        { error: toRunError(err) },
        deps.now(),
      );
      return;
    }
    const recorded = await runs.recordOutput(runId, output);
    const abandoned = recorded === 'abandoned';
    if (output.finishReason !== 'detached' || !output.snapshotId) {
      await runs.finish(
        runId,
        abandoned ? 'cancelled' : 'done',
        { final: { status: null, finishReason: output.finishReason ?? null } },
        deps.now(),
      );
      return;
    }
    snapshotId = output.snapshotId;
    if (abandoned) stop('the turn route gave up waiting');
    else if (stopReason) abortTurn();
    const final = await agent.waitForSettled(snapshotId, turnContext);
    const status: FinishStatus = abandoned
      ? 'cancelled'
      : stopReason
        ? 'aborted'
        : 'done';
    await runs.finish(
      runId,
      status,
      {
        ...(stopReason && {
          error: { status: 'ABORTED', message: `Stopped: ${stopReason}.` },
        }),
        final: {
          status: final?.status ?? null,
          finishReason: final?.finishReason ?? null,
        },
      },
      deps.now(),
    );
  } catch (err) {
    logger.error(`Detached run ${runId} failed`, err);
    if (snapshotId && context) {
      await agent.abort(snapshotId, context).catch((abortErr: unknown) => {
        logger.error(`Failed to abort detached run ${runId}`, abortErr);
      });
    }
    await runs
      .finish(runId, 'failed', { error: toRunError(err) }, deps.now())
      .catch(() => undefined);
  } finally {
    stopRenewing();
    clearTimeout(deadlineTimer);
    if (lockHeld) await lock.release(lockKey, runId);
  }
}

/** Adapts a Genkit agent to {@link TaskAgent}. */
export function taskAgent<S>(agent: Agent<S>): TaskAgent {
  return {
    runTurn: async (input, init, context) =>
      (await agent.run({ ...input, detach: true }, { init, context })).result,
    abort: (snapshotId, context) => agent.abort(snapshotId, { context }),
    waitForSettled: (snapshotId, context) =>
      agent.waitForSnapshotData({ snapshotId, context }),
  };
}

async function getUserOrUndefined(uid: string) {
  try {
    return await getAuth().getUser(uid);
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === 'auth/user-not-found'
    ) {
      return undefined;
    }
    throw err;
  }
}

/**
 * Builds the Cloud Tasks worker that runs the detached turns of `agent`. Pass
 * the same `detach` object as the `detach` option of {@link onAgentRequest},
 * and export the function under its `queue` name. Tasks are not retried,
 * the timeout comes from `detach` (60 to 1800 seconds), and
 * `maxConcurrentDispatches` defaults to 10. While detached turns are off,
 * the worker refuses every task.
 */
export function onAgentTask<S>(
  agent: Agent<S>,
  handle: DetachedTurns<S>,
  taskOptions: Omit<TaskQueueOptions, 'retryConfig' | 'timeoutSeconds'> = {},
): TaskQueueFunction<AgentTaskData> {
  const detach = detachedTurnsConfig(handle);
  const runs = new FirestoreRunStore(detach.firestore, detach.runsCollection);
  const adapted = taskAgent(agent);
  return onTaskDispatched<AgentTaskData>(
    {
      ...taskOptions,
      rateLimits: { maxConcurrentDispatches: 10, ...taskOptions.rateLimits },
      retryConfig: { maxAttempts: 1 },
      timeoutSeconds: detach.functionTimeout,
    },
    async (request) => {
      const runId: unknown = request.data?.runId;
      if (typeof runId !== 'string' || !runId) {
        logger.error('Detached task without a runId.');
        return;
      }
      if (!detach.enabled()) {
        logger.warn(`Detached turns are off; refused run ${runId}.`);
        return;
      }
      await runDetachedTask(runId, {
        runs,
        lock: detach.lock,
        agent: adapted,
        getUser: getUserOrUndefined,
        instanceId: detach.instanceId,
        timeoutSeconds: detach.timeoutSeconds(),
        now: Date.now,
      });
    },
  );
}
