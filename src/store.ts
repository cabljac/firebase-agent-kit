import { createHash } from 'node:crypto';
import { FirestoreSessionStore } from '@genkit-ai/firebase/beta';
import { getFirestore } from 'firebase-admin/firestore';
import { GenkitError } from 'genkit';
import type { SessionStore, SessionStoreOptions } from 'genkit/beta';
import type { UserScopedStoreOptions } from './types.js';

const DEFAULT_COLLECTION = 'genkit-agent-sessions';

/**
 * Derives the Firestore path prefix for the authenticated user: the sha256 hex
 * of the uid. Throws `UNAUTHENTICATED` when the context carries no uid.
 */
export function uidPrefix(options?: SessionStoreOptions): string {
  const uid: unknown = options?.context?.auth?.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new GenkitError({
      status: 'UNAUTHENTICATED',
      message: 'An authenticated user is required to access agent sessions.',
    });
  }
  return createHash('sha256').update(uid).digest('hex');
}

/**
 * Creates a Firestore session store that isolates snapshots per authenticated
 * user. Every call requires `options.context.auth.uid` and fails with
 * `UNAUTHENTICATED` otherwise. Firestore is resolved on first use.
 */
export function createUserScopedStore<S = unknown>(
  opts?: UserScopedStoreOptions,
): SessionStore<S> {
  let inner: FirestoreSessionStore<S> | undefined;
  const store = (): FirestoreSessionStore<S> =>
    (inner ??= new FirestoreSessionStore<S>({
      db: opts?.firestore ?? getFirestore(),
      collection: opts?.collection ?? DEFAULT_COLLECTION,
      snapshotPathPrefix: uidPrefix,
    }));

  return {
    getSnapshot: (o) => store().getSnapshot(o),
    saveSnapshot: (id, mutator, options) =>
      store().saveSnapshot(id, mutator, options),
    onSnapshotStateChange: (id, cb, options) =>
      store().onSnapshotStateChange?.(id, cb, options),
  };
}
