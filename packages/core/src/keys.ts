import { createHash } from 'node:crypto';

/**
 * Derives the key of a user within a scope: the sha256 hex of the JSON array
 * `[scope, uid]`, with `null` for no scope. Distinct (scope, uid) pairs give
 * distinct keys.
 */
export function userKey(uid: string, scope?: string): string {
  return createHash('sha256')
    .update(JSON.stringify([scope ?? null, uid]))
    .digest('hex');
}

/**
 * Builds the turn lock key of a session: the unscoped {@link userKey} of
 * `uid`, a colon, then `sessionId`.
 */
export function lockKey(uid: string, sessionId: string): string {
  // userKey is fixed-length hex, so the first colon always ends it.
  return `${userKey(uid)}:${sessionId}`;
}
