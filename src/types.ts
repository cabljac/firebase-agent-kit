import type { Firestore } from 'firebase-admin/firestore';
import type { HttpsOptions } from 'firebase-functions/v2/https';
import type { ActionContext, SessionStore } from 'genkit/beta';

/** Options for {@link createUserScopedStore}. */
export interface UserScopedStoreOptions {
  /** Root Firestore collection for snapshots. Defaults to `genkit-agent-sessions`. */
  collection?: string;
  /** Firestore instance. Defaults to `getFirestore()` on the default app. */
  firestore?: Firestore;
}

/** A held per-session turn lock. */
export interface TurnLease {
  /** The lock key (a session id). */
  readonly key: string;
  /** Random id of this holder; only this holder can release the lease. */
  readonly owner: string;
  /** Releases the lease if this holder still owns it. Never throws. */
  release(): Promise<void>;
}

/** Serializes turns per session. */
export interface TurnLock {
  /**
   * Acquires the lock for `key`, or returns `null` when another live holder
   * owns it. An expired lease (older than its `leaseMs`) is taken over.
   */
  acquire(key: string, opts: { leaseMs: number }): Promise<TurnLease | null>;
}

/** Options for {@link FirestoreTurnLock}. */
export interface FirestoreTurnLockOptions {
  /** Collection holding one lock document per session. Defaults to `genkit-agent-locks`. */
  collection?: string;
  /** Firestore instance. Defaults to `getFirestore()` on the default app. */
  firestore?: Firestore;
  /** Clock in epoch ms, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Options for {@link onAgentRequest}. */
export interface AgentRequestOptions<S = unknown> {
  /**
   * The same store instance passed to the agent's `store` config. Used to
   * resolve a `snapshotId` to its session for turn locking.
   */
  store: SessionStore<S>;
  /** Passed through to `onRequest`. `timeoutSeconds` also sizes the lock lease. */
  httpsOptions?: HttpsOptions;
  /** Turn lock. Defaults to a {@link FirestoreTurnLock}; `false` disables locking. */
  lock?: TurnLock | false;
  /** Reject requests without a valid App Check token. Defaults to `false`. */
  enforceAppCheck?: boolean;
  /**
   * Runs on each turn request after authentication and before the turn lock.
   * Throw a `GenkitError` to reject the turn with that status.
   */
  beforeTurn?: (context: ActionContext) => void | Promise<void>;
}

/**
 * Status values this library returns, as Genkit `StatusName`s. Each maps to an
 * HTTP status through `GenkitError`.
 */
export type AgentRequestErrorStatus =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'FAILED_PRECONDITION'
  | 'ABORTED';
