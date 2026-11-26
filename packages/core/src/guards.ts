import type express from 'express';
import { logger } from 'firebase-functions';
import { GenkitError, z } from 'genkit';
import type { ActionContext, Agent } from 'genkit/beta';
import { lockKey } from './keys.js';
import type { AgentAuthContext, AgentRequestContext } from './types.js';

const DetachInputSchema = z.object({ detach: z.literal(true) });
const AuthContextSchema = z.object({
  auth: z.object({ uid: z.string().min(1) }),
});
const AuthedContextSchema = z.object({
  auth: z.object({
    uid: z.string().min(1),
    token: z.object({}).passthrough(),
  }),
});
const RequestContextSchema = z.object({
  auth: z.object({
    uid: z.string().min(1),
    token: z.object({}).passthrough(),
    rawToken: z.string(),
  }),
});
const InitIdsSchema = z.object({
  sessionId: z.string().optional(),
  snapshotId: z.string().optional(),
});

/** Rejects turns that ask to detach, for an agent that has no detach config. */
export function assertNotDetach(input: unknown): void {
  if (DetachInputSchema.safeParse(input).success) {
    throw new GenkitError({
      status: 'FAILED_PRECONDITION',
      message:
        'Detached turns are not supported on Cloud Functions in this version.',
    });
  }
}

/**
 * True when `context` carries Firebase Auth data with a non-empty uid and
 * decoded token claims. Holds for HTTP turns and for detached turns in the
 * worker, which has no raw ID token.
 */
export function isAuthedContext<C extends ActionContext>(
  context: C,
): context is C & AgentAuthContext {
  return AuthedContextSchema.safeParse(context).success;
}

/** True when `context` came from a verified Firebase Auth ID token. */
export function isRequestContext<C extends ActionContext>(
  context: C,
): context is C & AgentRequestContext {
  return RequestContextSchema.safeParse(context).success;
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
 * Returns the session an agent init payload resumes. Follows Genkit's resume
 * precedence: a non-empty `snapshotId` wins over `sessionId`, and empty ids
 * count as absent. A `snapshotId` is read through the agent's own store.
 * Returns `undefined` for a new session or an unknown `snapshotId`.
 */
export async function resolveSessionId<S>(
  init: unknown,
  agent: Pick<Agent<S>, 'getSnapshotData'>,
  context: ActionContext,
): Promise<string | undefined> {
  requireUid(context);
  const ids = InitIdsSchema.safeParse(init);
  if (!ids.success) return undefined;
  const { sessionId, snapshotId } = ids.data;
  if (snapshotId) {
    const snapshot = await agent.getSnapshotData({
      snapshotId,
      metadataOnly: true,
      context,
    });
    return snapshot?.sessionId || undefined;
  }
  return sessionId || undefined;
}

/**
 * Computes the turn lock key ({@link lockKey}) for an agent init payload, or
 * `undefined` when {@link resolveSessionId} finds no session.
 */
export async function resolveLockKey<S>(
  init: unknown,
  agent: Pick<Agent<S>, 'getSnapshotData'>,
  context: ActionContext,
): Promise<string | undefined> {
  const uid = requireUid(context);
  const sessionId = await resolveSessionId(init, agent, context);
  return sessionId ? lockKey(uid, sessionId) : undefined;
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
