import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { logger } from 'firebase-functions/logger';
import {
  onTaskDispatched,
  type TaskQueueFunction,
  type TaskQueueOptions,
} from 'firebase-functions/v2/tasks';
import { GenkitError } from 'genkit';
import type { Agent, AgentInit, AgentInput, AgentOutput } from 'genkit/beta';
import { RENEW_INTERVAL_MS, WORKER_LEASE_MS } from './detach.js';
import {
  FirestoreRunStore,
  type RunError,
  type RunStore,
  refreshClaims,
  userCheckFailure,
} from './runs.js';
import type { AgentAuthContext, DetachedTurns, TurnLock } from './types.js';

/** The worker aborts its turn this long before its deadline. */
export const SELF_ABORT_MARGIN_MS = 20_000;

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
 * renewed while the turn runs; a failed renewal aborts the turn. The turn is
 * also aborted shortly before the deadline, and when the turn route gave up
 * on it. The lock is released at the end.
 */
export async function runDetachedTask(
  runId: string,
  deps: WorkerDeps,
): Promise<void> {
  const { runs, lock, agent } = deps;
  const startedAt = deps.now();
  const claimed = await runs.claim(runId, deps.instanceId, startedAt);
  if (typeof claimed === 'string') {
    logger.warn(`Refused detached run ${runId}: ${claimed}.`);
    return;
  }
  const { uid, lockKey } = claimed;
  let lockHeld = false;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
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
    const context: AgentAuthContext = {
      auth: { uid, token: refreshClaims(claimed.claims, user.customClaims) },
    };

    let snapshotId: string | undefined;
    let stopReason: string | undefined;
    const abortTurn = () => {
      if (!snapshotId) return;
      agent.abort(snapshotId, context).catch((err: unknown) => {
        logger.error(`Failed to abort detached run ${runId}`, err);
      });
    };
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      logger.warn(`Stopping detached run ${runId}: ${reason}.`);
      abortTurn();
    };
    renewTimer = setInterval(() => {
      lock.renew(lockKey, runId, WORKER_LEASE_MS).then(
        (ok) => {
          if (!ok) stop('the session lock was lost');
        },
        (err: unknown) => {
          logger.warn(`Failed to renew the lock of run ${runId}`, err);
        },
      );
    }, RENEW_INTERVAL_MS);
    deadlineTimer = setTimeout(
      () => stop('the worker deadline is near'),
      deps.timeoutSeconds * 1000 -
        SELF_ABORT_MARGIN_MS -
        (deps.now() - startedAt),
    );

    let output: AgentOutput;
    try {
      output = await agent.runTurn(
        claimed.input,
        claimed.init ?? undefined,
        context,
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
    const final = await agent.waitForSettled(snapshotId, context);
    await runs.finish(
      runId,
      abandoned ? 'cancelled' : 'done',
      {
        final: {
          status: final?.status ?? null,
          finishReason: final?.finishReason ?? null,
        },
      },
      deps.now(),
    );
  } catch (err) {
    logger.error(`Detached run ${runId} failed`, err);
    await runs
      .finish(runId, 'failed', { error: toRunError(err) }, deps.now())
      .catch(() => undefined);
  } finally {
    clearInterval(renewTimer);
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
 * and export the function under the name `detach.queue`. Tasks are not
 * retried, the timeout comes from `detach` (at most 1800 seconds), and
 * `maxConcurrentDispatches` defaults to 10. When `detach.enabled()` is false
 * the worker refuses every task.
 */
export function onAgentTask<S>(
  agent: Agent<S>,
  detach: DetachedTurns<S>,
  taskOptions: Omit<TaskQueueOptions, 'retryConfig' | 'timeoutSeconds'> = {},
): TaskQueueFunction<AgentTaskData> {
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
