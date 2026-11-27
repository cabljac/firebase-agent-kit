import type express from 'express';
import { getFirestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/logger';
import { Expression } from 'firebase-functions/params';
import { GenkitError } from 'genkit';
import type { AgentInit, AgentInput, AgentOutput } from 'genkit/beta';
import {
  type DetachedTurns,
  detachedTurnsConfig,
  detachedTurnsHandle,
} from './detached-turns.js';
import { lockKey } from './keys.js';
import { FirestoreTurnLock } from './lock.js';
import { reapDeadTip } from './reaper.js';
import {
  assertRunFits,
  FirestoreRunStore,
  type NewRun,
  type RunDoc,
  type RunStore,
} from './runs.js';
import type {
  AgentRequestContext,
  DetachedTurnsOptions,
  TurnLease,
  TurnLock,
} from './types.js';

/** How long the turn route waits for a worker to claim the run. */
export const CLAIM_WAIT_MS = 20_000;
/** How long the turn route then waits for the worker's detached output. */
export const OUTPUT_WAIT_MS = 20_000;
/** The worker's lock lease, renewed every {@link RENEW_INTERVAL_MS}. */
export const WORKER_LEASE_MS = 90_000;
/** How often the worker renews its lock lease. */
export const RENEW_INTERVAL_MS = 30_000;
/** The lease the turn route takes for a detached turn, until the worker renews it. */
export const DETACH_LEASE_MS = CLAIM_WAIT_MS + OUTPUT_WAIT_MS + WORKER_LEASE_MS;
/** Waits between attempts to take a busy turn lock. */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 800];

const DEFAULT_RUNS_COLLECTION = 'agent-kit-runs';
const DEFAULT_WORKER_TIMEOUT_SECONDS = 540;
/** The longest timeout a task queue function can have. */
export const MAX_WORKER_TIMEOUT_SECONDS = 1800;
/** The shortest worker timeout: the self-abort margin needs room. */
export const MIN_WORKER_TIMEOUT_SECONDS = 60;

/** Clamps a worker timeout to 60..1800 seconds; unset or invalid gives 540. */
export function clampWorkerTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WORKER_TIMEOUT_SECONDS;
  }
  return Math.min(
    MAX_WORKER_TIMEOUT_SECONDS,
    Math.max(MIN_WORKER_TIMEOUT_SECONDS, Math.floor(value)),
  );
}

/**
 * Builds the detached turn config shared by {@link onAgentRequest} (its
 * `detach` option) and {@link onAgentTask}. Pass the same object to both, so
 * the turn route and the worker agree on the queue, store, lock and runs.
 */
export function defineDetachedTurns<S>(
  options: DetachedTurnsOptions<S>,
): DetachedTurns<S> {
  if (!options.queue) {
    throw new Error('defineDetachedTurns: queue is required.');
  }
  const { enabled, timeoutSeconds } = options;
  return detachedTurnsHandle({
    queue: options.queue,
    store: options.store,
    instanceId: options.instanceId ?? null,
    lock: options.lock ?? new FirestoreTurnLock(),
    runsCollection: options.runs?.collection ?? DEFAULT_RUNS_COLLECTION,
    enabled: () =>
      enabled === undefined
        ? true
        : enabled instanceof Expression
          ? enabled.value()
          : enabled,
    timeoutSeconds: () =>
      clampWorkerTimeout(
        timeoutSeconds instanceof Expression
          ? timeoutSeconds.value()
          : timeoutSeconds,
      ),
    functionTimeout:
      timeoutSeconds instanceof Expression
        ? timeoutSeconds
        : clampWorkerTimeout(timeoutSeconds),
    firestore: () => options.runs?.firestore ?? getFirestore(),
  });
}

/** The seams of the detached turn route, replaced in tests. */
export interface DetachDeps {
  runs: RunStore;
  enqueue(runId: string, dispatchDeadlineSeconds: number): Promise<void>;
  newRunId(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  claimWaitMs: number;
  outputWaitMs: number;
}

/**
 * The production seams for `detach`. `region` names the region of the
 * worker, which shares the turn route's region.
 */
export function defaultDetachDeps<S>(
  handle: DetachedTurns<S>,
  region: () => string | undefined,
): DetachDeps {
  const detach = detachedTurnsConfig(handle);
  return {
    runs: new FirestoreRunStore(detach.firestore, detach.runsCollection),
    enqueue: async (runId, dispatchDeadlineSeconds) => {
      const location = region();
      const name = location
        ? `locations/${location}/functions/${detach.queue}`
        : detach.queue;
      await getFunctions()
        .taskQueue<{ runId: string }>(name)
        .enqueue({ runId }, { id: runId, dispatchDeadlineSeconds });
    },
    newRunId: () => crypto.randomUUID(),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    claimWaitMs: CLAIM_WAIT_MS,
    outputWaitMs: OUTPUT_WAIT_MS,
  };
}

/**
 * Takes `key`, retrying a busy lock after each of
 * {@link LOCK_RETRY_DELAYS_MS}. Returns `null` when it stays busy.
 */
export async function acquireWithRetry(
  lock: TurnLock,
  key: string,
  opts: { leaseMs: number; owner?: string },
  sleep: (ms: number) => Promise<void>,
): Promise<TurnLease | null> {
  for (const delay of [0, ...LOCK_RETRY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    const lease = await lock.acquire(key, opts);
    if (lease) return lease;
  }
  return null;
}

/** The 409 for a session whose lock another turn holds. */
export function busyError(): GenkitError {
  return new GenkitError({
    status: 'ABORTED',
    message: 'Another turn is running for this session.',
  });
}

/** True when the client asked for the streaming (SSE) response. */
export function wantsStream(req: express.Request): boolean {
  return (
    req.get('Accept')?.toLowerCase().includes('text/event-stream') === true ||
    req.query.stream === 'true'
  );
}

/**
 * Writes a turn result the way `@genkit-ai/express` does: one final SSE
 * frame for a streaming request, else a `{ result }` JSON body.
 */
export function writeTurnResult(
  req: express.Request,
  res: express.Response,
  output: AgentOutput,
): void {
  if (wantsStream(req)) {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Transfer-Encoding': 'chunked',
    });
    res.write(`data: ${JSON.stringify({ result: output })}\n\n`);
    res.end();
    return;
  }
  res.status(200).json({ result: output });
}

type WaitResult =
  | { kind: 'run'; run: RunDoc | undefined }
  | { kind: 'timeout' }
  | { kind: 'closed' };

/**
 * Waits until `done(run)`, the timeout, or the client closing. A failed watch
 * is logged and counts as a timeout, so the caller cancels or abandons the
 * run the same way.
 */
function waitForRun(
  runs: RunStore,
  runId: string,
  done: (run: RunDoc | undefined) => boolean,
  timeoutMs: number,
  closed: AbortSignal,
): Promise<WaitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closed.removeEventListener('abort', onClose);
      unsubscribe?.();
      resolve(result);
    };
    const onClose = () => finish({ kind: 'closed' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    if (closed.aborted) {
      onClose();
      return;
    }
    closed.addEventListener('abort', onClose, { once: true });
    try {
      unsubscribe = runs.watch(
        runId,
        (run) => {
          if (done(run)) finish({ kind: 'run', run });
        },
        (err) => {
          logger.error(`Lost the watch on detached run ${runId}`, err);
          finish({ kind: 'timeout' });
        },
      );
    } catch (err) {
      logger.error(`Could not watch detached run ${runId}`, err);
      finish({ kind: 'timeout' });
    }
    if (settled) unsubscribe?.();
  });
}

const hasResult = (run: RunDoc | undefined) =>
  !run ||
  run.output !== undefined ||
  run.status === 'failed' ||
  run.status === 'cancelled' ||
  run.status === 'done' ||
  run.status === 'abandoned';

function resultOf(run: RunDoc | undefined): AgentOutput {
  if (run?.output) return run.output;
  if (run?.error) {
    throw new GenkitError({
      status: run.error.status,
      message: run.error.message,
    });
  }
  throw new GenkitError({
    status: 'INTERNAL',
    message: 'The detached turn ended without a result.',
  });
}

/** Arguments of {@link startDetachedTurn}. */
export interface DetachedTurnRequest<S> {
  req: express.Request;
  res: express.Response;
  context: AgentRequestContext;
  input: AgentInput;
  init: AgentInit | undefined;
  sessionId: string;
  detach: DetachedTurns<S>;
  deps: DetachDeps;
}

/**
 * Hands a detached turn to the worker: takes the session lock for the run,
 * settles a dead detached tip, writes the run, enqueues it, waits for the
 * claim and then for the worker's detached output, and relays that output.
 * A run nobody claimed in time, or whose client went away while it was
 * queued, is cancelled and its lock released. A claimed run without output in
 * time is abandoned, and the worker aborts its turn.
 */
export async function startDetachedTurn<S>(
  request: DetachedTurnRequest<S>,
): Promise<void> {
  const { req, res, context, deps } = request;
  const detach = detachedTurnsConfig(request.detach);
  const { runs } = deps;
  const runId = deps.newRunId();
  const key = lockKey(context.auth.uid, request.sessionId);
  const run: NewRun = {
    uid: context.auth.uid,
    instanceId: detach.instanceId,
    lockKey: key,
    input: request.input,
    init: request.init ?? null,
    claims: context.auth.token,
  };
  assertRunFits(run);

  const closedController = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) closedController.abort();
  };
  res.on('close', onClose);
  const lease = await acquireWithRetry(
    detach.lock,
    key,
    { leaseMs: DETACH_LEASE_MS, owner: runId },
    deps.sleep,
  );
  if (!lease) throw busyError();

  const cancelQueued = async (
    status: 'CANCELLED' | 'UNAVAILABLE',
    message: string,
  ) => {
    const cancelled = await runs.cancelIfQueued(runId, { status, message });
    if (cancelled) await lease.release();
    return cancelled;
  };

  try {
    await reapDeadTip(detach.store, request.sessionId, context);
    await runs.create(runId, run, deps.now());
  } catch (err) {
    await lease.release();
    throw err;
  }
  try {
    await deps.enqueue(runId, detach.timeoutSeconds());
  } catch (err) {
    logger.error(`Failed to enqueue detached run ${runId}`, err);
    await cancelQueued('UNAVAILABLE', 'The detached turn could not be queued.');
    throw new GenkitError({
      status: 'UNAVAILABLE',
      message: 'The detached turn could not be queued. Try again.',
    });
  }

  const claimed = await waitForRun(
    runs,
    runId,
    (r) => r?.status !== 'queued',
    deps.claimWaitMs,
    closedController.signal,
  );
  if (claimed.kind !== 'run') {
    const message =
      claimed.kind === 'closed'
        ? 'The client closed the request before a worker started the turn.'
        : 'No worker started the detached turn in time.';
    const cancelled = await cancelQueued(
      claimed.kind === 'closed' ? 'CANCELLED' : 'UNAVAILABLE',
      message,
    );
    if (claimed.kind === 'closed') return;
    if (cancelled) {
      throw new GenkitError({
        status: 'UNAVAILABLE',
        message: `${message} It was cancelled; try again.`,
      });
    }
  }

  let result = await waitForRun(
    runs,
    runId,
    hasResult,
    deps.outputWaitMs,
    closedController.signal,
  );
  if (result.kind === 'closed') return;
  if (result.kind === 'timeout') {
    const outcome = await runs.abandonIfNoOutput(runId);
    if (outcome.abandoned) {
      throw new GenkitError({
        status: 'UNAVAILABLE',
        message:
          'The detached turn did not start in time. It was cancelled; retry in a few seconds.',
      });
    }
    result = { kind: 'run', run: outcome.run };
  }
  res.off('close', onClose);
  writeTurnResult(req, res, resultOf(result.run));
}
