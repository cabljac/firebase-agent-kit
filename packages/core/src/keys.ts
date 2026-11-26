import { createHash } from 'node:crypto';

/**
 * Derives the key of a user within a scope: the sha256 hex of the JSON array
 * `[scope, uid]`, with `null` for no scope.
 */
export function userKey(uid: string, scope?: string): string {
  return createHash('sha256')
    .update(JSON.stringify([scope ?? null, uid]))
    .digest('hex');
}

/** Builds the turn lock key of one session of one user. */
export function lockKey(uid: string, sessionId: string): string {
  return `${userKey(uid)}:${sessionId}`;
}
