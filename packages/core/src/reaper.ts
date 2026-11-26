import type { ActionContext } from 'genkit';
import type { SessionSnapshot, SessionState, SessionStore } from 'genkit/beta';

/** A heartbeat older than this means the detached turn's worker is dead. */
export const DEAD_HEARTBEAT_MS = 60_000;

/**
 * True when `snapshot` is a detached row (`pending` or `aborting`) whose
 * last heartbeat (or last write, without one) is older than
 * {@link DEAD_HEARTBEAT_MS}.
 */
export function isDeadDetachedRow(
  snapshot: SessionSnapshot<unknown>,
  now: number,
): boolean {
  if (snapshot.status !== 'pending' && snapshot.status !== 'aborting') {
    return false;
  }
  const last = Date.parse(
    snapshot.heartbeatAt ?? snapshot.updatedAt ?? snapshot.createdAt,
  );
  return !Number.isNaN(last) && now - last > DEAD_HEARTBEAT_MS;
}

/**
 * The terminal form of a dead detached row: `aborted`, with the state of its
 * parent (empty without one) and no heartbeat. Genkit's finalize never
 * overwrites an `aborted` row, and resumes from it like any aborted turn.
 */
export function reapedSnapshot<S>(
  row: SessionSnapshot<S>,
  parentState: SessionState<S> | undefined,
  now: number,
): SessionSnapshot<S> {
  const { heartbeatAt: _, ...base } = row;
  const sessionId = row.sessionId ?? parentState?.sessionId;
  return {
    ...base,
    status: 'aborted',
    finishReason: 'aborted',
    error: {
      status: 'ABORTED',
      message:
        'The worker of this detached turn stopped; the turn was settled as aborted.',
    },
    state: parentState ?? { sessionId, messages: [], artifacts: [] },
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * Settles the tip of `sessionId` as aborted when it is a dead detached row.
 * Call it only while holding the session's turn lock. Resolves `true` when
 * it wrote the row.
 */
export async function reapDeadTip<S>(
  store: SessionStore<S>,
  sessionId: string,
  context: ActionContext,
  now: () => number = Date.now,
): Promise<boolean> {
  const tip = await store.getSnapshot({ sessionId, context });
  if (!tip || !isDeadDetachedRow(tip, now())) return false;
  const parent = tip.parentId
    ? await store.getSnapshot({ snapshotId: tip.parentId, context })
    : undefined;
  let reaped = false;
  await store.saveSnapshot(
    tip.snapshotId,
    (current) => {
      reaped = false;
      if (!current || !isDeadDetachedRow(current, now())) return null;
      reaped = true;
      return reapedSnapshot(current, parent?.state, now());
    },
    { context },
  );
  return reaped;
}
