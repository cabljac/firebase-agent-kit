import type { FirebaseContext } from '@genkit-ai/firebase/context';
import type { Firestore } from 'firebase-admin/firestore';
import type { Expression } from 'firebase-functions/params';
import type { HttpsOptions } from 'firebase-functions/v2/https';
import type { AgentInit, AgentInput } from 'genkit/beta';

/** Options for {@link createUserScopedStore}. */
export interface UserScopedStoreOptions {
  /** Root Firestore collection for snapshots. Defaults to `agent-kit-sessions`. */
  collection?: string;
  /**
   * Scope of the sessions, for example an agent name. Stores with different
   * scopes cannot load each other's sessions, even for the same user. Defaults
   * to no scope.
   */
  scope?: string;
  /** Firestore instance. Defaults to `getFirestore()` on the default app. */
  firestore?: Firestore;
}

/** A held per-session turn lock. */
export interface TurnLease {
  /** The lock key, which identifies one session of one user. */
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
  /** Collection holding one lock document per session. Defaults to `agent-kit-locks`. */
  collection?: string;
  /** Firestore instance. Defaults to `getFirestore()` on the default app. */
  firestore?: Firestore;
}

/** The context of a request that passed Firebase Auth. */
export type AgentRequestContext = FirebaseContext & {
  auth: NonNullable<FirebaseContext['auth']>;
};

/** A route that {@link onAgentRequest} serves. `turn` is the main route. */
export type AgentRoute = 'turn' | 'getSnapshot' | 'waitForSnapshot' | 'abort';

/** Argument of the {@link AgentRequestOptions.authorize} hook. */
export interface AuthorizeRequest {
  /** The route of this request. */
  route: AgentRoute;
  /** The authenticated request context. */
  context: AgentRequestContext;
}

/** Argument of the {@link AgentRequestOptions.beforeTurn} hook. */
export interface BeforeTurnRequest {
  /** The authenticated request context. */
  context: AgentRequestContext;
  /** The turn input. */
  input: AgentInput;
  /** The session init, or `undefined` when the request has none. */
  init: AgentInit | undefined;
}

/** Options for {@link onAgentRequest}. */
export interface AgentRequestOptions {
  /**
   * Passed through to `onRequest`. Set `cors` here for browser clients. The
   * function's timeout (`timeoutSeconds` here, else from `setGlobalOptions`,
   * else 60 seconds) plus 30 seconds sizes the lock lease.
   */
  httpsOptions?: HttpsOptions;
  /**
   * Turn lock. Defaults to a {@link FirestoreTurnLock}; `false` disables
   * locking, which is safe only when turns on one session never overlap.
   */
  lock?: TurnLock | false;
  /**
   * Reject requests without a valid App Check token. Defaults to `false`. A
   * params expression (for example `defineBoolean('ENFORCE_APP_CHECK')`) is
   * read on each request.
   */
  enforceAppCheck?: boolean | Expression<boolean>;
  /**
   * Runs on every route after authentication and App Check. Throw a
   * `GenkitError` to reject the request with that status; any other error
   * answers 500.
   */
  authorize?: (request: AuthorizeRequest) => void | Promise<void>;
  /**
   * Runs on each turn after `authorize` and before the turn lock. Throw a
   * `GenkitError` to reject the turn with that status; any other error
   * answers 500.
   */
  beforeTurn?: (turn: BeforeTurnRequest) => void | Promise<void>;
}
