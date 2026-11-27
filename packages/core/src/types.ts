import type { FirebaseContext } from '@genkit-ai/firebase/context';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Expression } from 'firebase-functions/params';
import type { HttpsOptions } from 'firebase-functions/v2/https';
import type { AgentInit, AgentInput, SessionStore } from 'genkit/beta';
import type { DetachedTurns } from './detached-turns.js';

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
   * `owner` names the holder; a random id is used when it is omitted.
   */
  acquire(
    key: string,
    opts: { leaseMs: number; owner?: string },
  ): Promise<TurnLease | null>;
  /**
   * Extends the lease of `owner` on `key` to `leaseMs` from now. Resolves
   * `false` when `owner` no longer holds the lock.
   */
  renew(key: string, owner: string, leaseMs: number): Promise<boolean>;
  /** Releases `key` if `owner` still holds it. Never throws. */
  release(key: string, owner: string): Promise<void>;
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

/**
 * The authenticated caller of a turn, on the HTTP route and in the
 * {@link onAgentTask} worker. The worker has no raw ID token, and its
 * `token` holds the claims frozen at enqueue time with custom claims
 * refreshed when the worker claimed the run; its `iat` and `exp` are those of
 * the original ID token and can be in the past.
 */
export interface AgentAuthContext {
  auth: { uid: string; token: DecodedIdToken };
}

/** Options for {@link defineDetachedTurns}. */
export interface DetachedTurnsOptions<S = unknown> {
  /**
   * The export name of the {@link onAgentTask} function, which is also its
   * task queue. Inside a kit instance, firebase-admin adds the
   * `kit-<instance>-` prefix.
   */
  queue: string;
  /**
   * The agent's own session store. The turn route writes through it to settle
   * the snapshot of a detached turn whose worker died.
   */
  store: SessionStore<S>;
  /**
   * Turns detached turns on or off. Defaults to `true`. A params expression
   * is read on each request and each task. When off, a turn with
   * `detach: true` gets 400 `FAILED_PRECONDITION` and the worker refuses work.
   */
  enabled?: boolean | Expression<boolean>;
  /**
   * The worker's timeout in seconds. Defaults to 540 and is capped at 1800.
   */
  timeoutSeconds?: number | Expression<number>;
  /** The kit instance id, recorded on each run; a worker refuses runs of another instance. */
  instanceId?: string;
  /**
   * The turn lock, used for every turn of the agent. Defaults to a
   * {@link FirestoreTurnLock}.
   */
  lock?: TurnLock;
  /** Where runs are stored. The collection defaults to `agent-kit-runs`. */
  runs?: { collection?: string; firestore?: Firestore };
}

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
export interface AgentRequestOptions<S = unknown> {
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
  /**
   * Accepts turns with `detach: true` and hands them to the
   * {@link onAgentTask} worker built from the same object. Without it, such a
   * turn gets 400 `FAILED_PRECONDITION`. Do not set `lock` with it: the lock
   * comes from the detach config.
   */
  detach?: DetachedTurns<S>;
}

/** The resolved detached turn config behind a {@link DetachedTurns} handle. */
export interface DetachedTurnsConfig<S = unknown> {
  readonly queue: string;
  readonly store: SessionStore<S>;
  readonly instanceId: string | null;
  readonly lock: TurnLock;
  readonly runsCollection: string;
  /** Whether detached turns are on, read now. */
  enabled(): boolean;
  /** The worker timeout in seconds, read now and clamped to 60..1800. */
  timeoutSeconds(): number;
  /** The worker timeout for the function definition. */
  readonly functionTimeout: number | Expression<number>;
  /** Firestore for runs, resolved on first use. */
  firestore(): Firestore;
}
