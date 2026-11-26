import type express from 'express';
import { logger } from 'firebase-functions';
import { GenkitError, z } from 'genkit';
import type { ActionContext, SessionStore } from 'genkit/beta';

const DetachInputSchema = z.object({ detach: z.literal(true) });
const AuthContextSchema = z.object({
  auth: z.object({ uid: z.string().min(1) }),
});
const InitIdsSchema = z.object({
  sessionId: z.string().optional(),
  snapshotId: z.string().optional(),
});

/**
 * Rejects turns that ask to detach, which Cloud Functions cannot keep running
 * after the response ends.
 */
export function assertNotDetach(input: unknown): void {
  if (DetachInputSchema.safeParse(input).success) {
    throw new GenkitError({
      status: 'FAILED_PRECONDITION',
      message:
        'Detached turns are not supported on Cloud Functions in this version.',
    });
  }
}

/** Returns the authenticated user id from `context`, or throws UNAUTHENTICATED. */
export function requireUid(context: ActionContext | undefined): string {
  const parsed = AuthContextSchema.safeParse(context);
  if (!parsed.success) {
    throw new GenkitError({
      status: 'UNAUTHENTICATED',
      message: 'Authentication is required.',
    });
  }
  return parsed.data.auth.uid;
}

/**
 * Computes the turn lock key (`<uid>:<sessionId>`) for an agent init payload.
 * Follows Genkit's resume precedence: a non-empty `snapshotId` wins over
 * `sessionId`, and empty ids count as absent. Returns `undefined` for a new
 * session or an unknown `snapshotId`.
 */
export async function resolveLockKey<S>(
  init: unknown,
  store: SessionStore<S>,
  context: ActionContext,
): Promise<string | undefined> {
  const uid = requireUid(context);
  const ids = InitIdsSchema.safeParse(init);
  if (!ids.success) return undefined;
  const { sessionId, snapshotId } = ids.data;
  if (snapshotId) {
    const snapshot = await store.getSnapshot({
      snapshotId,
      metadataOnly: true,
      context,
    });
    return snapshot?.sessionId ? `${uid}:${snapshot.sessionId}` : undefined;
  }
  return sessionId ? `${uid}:${sessionId}` : undefined;
}

/** Writes `err` as a JSON error response; unknown errors become a logged 500. */
export function sendError(res: express.Response, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof GenkitError) {
    res.status(err.code).json(err.toJSON());
    return;
  }
  logger.error('Unhandled agent request error', err);
  res.status(500).json({ status: 'INTERNAL', message: 'Internal Error' });
}
