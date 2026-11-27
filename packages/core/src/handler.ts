import { randomUUID } from 'node:crypto';
import { expressHandler } from '@genkit-ai/express';
import {
  firebaseContext,
  setDebugSkipTokenVerification,
} from '@genkit-ai/firebase/context';
import express from 'express';
import { Expression } from 'firebase-functions/params';
import {
  type HttpsFunction,
  type HttpsOptions,
  onRequest,
} from 'firebase-functions/v2/https';
import { GenkitError } from 'genkit';
import { type Agent, AgentInitSchema, AgentInputSchema } from 'genkit/beta';
import type { ContextProvider, RequestData } from 'genkit/context';
import {
  acquireWithRetry,
  busyError,
  type DetachDeps,
  defaultDetachDeps,
  startDetachedTurn,
} from './detach.js';
import { detachedTurnsConfig } from './detached-turns.js';
import {
  assertNotDetach,
  isRequestContext,
  resolveSessionId,
  sendError,
} from './guards.js';
import { lockKey } from './keys.js';
import { FirestoreTurnLock } from './lock.js';
import { reapDeadTip } from './reaper.js';
import type {
  AgentRequestOptions,
  AgentRoute,
  BeforeTurnRequest,
  TurnLease,
  TurnLock,
} from './types.js';

/** Test seams for {@link createAgentApp}. */
export interface AgentAppDeps {
  /** Replaces the Firebase auth context provider. */
  contextProvider?: ContextProvider;
  /** Returns the function's `timeoutSeconds`. Defaults to `opts.httpsOptions?.timeoutSeconds`. */
  timeoutSeconds?: () => HttpsOptions['timeoutSeconds'];
  /** Returns the function's region, which is also the worker's. */
  region?: () => string | undefined;
  /** Replaces the seams of the detached turn route. */
  detach?: Partial<DetachDeps>;
  /** Waits between lock attempts. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_SECONDS = 60;
const LEASE_GRACE_MS = 30_000;

function toRequestData(req: express.Request): RequestData {
  return {
    method: req.method as RequestData['method'],
    headers: Object.fromEntries(
      Object.entries(req.headers)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key.toLowerCase(),
          Array.isArray(value) ? value.join(', ') : String(value),
        ]),
    ),
    input: req.body?.data,
  };
}

function toSeconds(timeout: HttpsOptions['timeoutSeconds']): number {
  const seconds = timeout instanceof Expression ? timeout.value() : timeout;
  // An unset int param reads as 0.
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_TIMEOUT_SECONDS;
}

function resolveRegion(region: unknown): string | undefined {
  const value = region instanceof Expression ? region.value() : region;
  return typeof value === 'string' && value ? value : undefined;
}

function resolveBoolean(value: boolean | Expression<boolean> | undefined) {
  return value instanceof Expression ? value.value() : Boolean(value);
}

function parseTurn(
  body: { data?: unknown; init?: unknown } | undefined,
): Omit<BeforeTurnRequest, 'context'> {
  const input = AgentInputSchema.safeParse(body?.data);
  const init = AgentInitSchema.optional().safeParse(body?.init);
  if (!input.success || !init.success) {
    throw new GenkitError({
      status: 'INVALID_ARGUMENT',
      message: 'Malformed agent turn request.',
    });
  }
  return { input: input.data, init: init.data };
}

function isClientError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('status' in err)) {
    return false;
  }
  return (
    typeof err.status === 'number' && err.status >= 400 && err.status < 500
  );
}

/**
 * Builds the express app that serves `agent` and its companion routes
 * (`/getSnapshot`, `/waitForSnapshot`, `/abort`). Every route requires a
 * signed-in user, and the main turn route holds a per-session lock.
 */
export function createAgentApp<S>(
  agent: Agent<S>,
  opts: AgentRequestOptions<S> = {},
  deps: AgentAppDeps = {},
): express.Express {
  const detach = opts.detach ? detachedTurnsConfig(opts.detach) : undefined;
  if (detach && opts.lock !== undefined) {
    throw new Error(
      'onAgentRequest: do not set lock together with detach; set lock in defineDetachedTurns.',
    );
  }
  // Emulator ID tokens are unsigned and fail the debug skip-verification decoder.
  if (
    process.env.FUNCTIONS_EMULATOR === 'true' &&
    process.env.FIREBASE_AUTH_EMULATOR_HOST
  ) {
    setDebugSkipTokenVerification(false);
  }
  const signedIn = firebaseContext({ signedIn: true });
  const signedInWithAppCheck = firebaseContext({
    signedIn: true,
    enforceAppCheck: true,
  });
  const contextProvider: ContextProvider =
    deps.contextProvider ??
    ((request) =>
      resolveBoolean(opts.enforceAppCheck)
        ? signedInWithAppCheck(request)
        : signedIn(request));
  const timeoutSeconds =
    deps.timeoutSeconds ?? (() => opts.httpsOptions?.timeoutSeconds);

  let defaultLock: TurnLock | undefined;
  const getLock = (): TurnLock => {
    if (detach) return detach.lock;
    if (opts.lock) return opts.lock;
    defaultLock ??= new FirestoreTurnLock();
    return defaultLock;
  };
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let detachDeps: DetachDeps | undefined;
  const getDetachDeps = (): DetachDeps | undefined => {
    const handle = opts.detach;
    if (!handle) return undefined;
    detachDeps ??= {
      ...defaultDetachDeps(handle, deps.region ?? (() => undefined)),
      sleep,
      ...deps.detach,
    };
    return detachDeps;
  };

  const route =
    (
      action: Parameters<typeof expressHandler>[0],
      name: AgentRoute,
    ): express.RequestHandler =>
    async (req, res) => {
      let lease: TurnLease | null = null;
      let closed = false;
      res.on('close', () => {
        closed = true;
        void lease?.release();
        lease = null;
      });
      try {
        const ctx = await contextProvider(toRequestData(req));
        if (!isRequestContext(ctx)) {
          throw new GenkitError({
            status: 'UNAUTHENTICATED',
            message: 'Authentication is required.',
          });
        }
        await opts.authorize?.({ route: name, context: ctx });
        if (name === 'turn') {
          const { input, init } = parseTurn(req.body);
          await opts.beforeTurn?.({ context: ctx, input, init });
          const detachDeps =
            input.detach && detach?.enabled() ? getDetachDeps() : undefined;
          if (!detachDeps) assertNotDetach(input);
          let sessionId = await resolveSessionId(init, agent, ctx);
          if (opts.detach && detachDeps) {
            if (!sessionId && init?.snapshotId) {
              throw new GenkitError({
                status: 'NOT_FOUND',
                message: `Snapshot ${init.snapshotId} not found.`,
              });
            }
            sessionId ??= randomUUID();
            await startDetachedTurn({
              req,
              res,
              context: ctx,
              input,
              init: { ...init, sessionId: init?.sessionId || sessionId },
              sessionId,
              detach: opts.detach,
              deps: detachDeps,
            });
            return;
          }
          if (sessionId && opts.lock !== false) {
            const leaseMs = toSeconds(timeoutSeconds()) * 1000 + LEASE_GRACE_MS;
            lease = await acquireWithRetry(
              getLock(),
              lockKey(ctx.auth.uid, sessionId),
              { leaseMs },
              sleep,
            );
            if (!lease) throw busyError();
            if (closed) {
              void lease.release();
              lease = null;
            }
            if (detach) await reapDeadTip(detach.store, sessionId, ctx);
          }
        }
        await expressHandler(action, { contextProvider: () => ctx })(
          req,
          res,
          () => undefined,
        );
      } catch (err) {
        sendError(res, err);
      }
    };

  const app = express();
  app.use(express.json());
  app.post('/', route(agent, 'turn'));
  app.post('/getSnapshot', route(agent.getSnapshotDataAction, 'getSnapshot'));
  app.post(
    '/waitForSnapshot',
    route(agent.waitForSnapshotAction, 'waitForSnapshot'),
  );
  app.post('/abort', route(agent.abortAgentAction, 'abort'));
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (isClientError(err)) {
        sendError(
          res,
          new GenkitError({
            status: 'INVALID_ARGUMENT',
            message: 'Malformed request body.',
          }),
        );
        return;
      }
      sendError(res, err);
    },
  );
  return app;
}

/**
 * Serves `agent` as a Cloud Function (HTTPS) with per-user sessions and
 * per-session turn locking. Routes match `remoteAgent({ url })`.
 */
export function onAgentRequest<S>(
  agent: Agent<S>,
  opts: AgentRequestOptions<S> = {},
): HttpsFunction {
  const fn: HttpsFunction = onRequest(
    opts.httpsOptions ?? {},
    createAgentApp(agent, opts, {
      // The deployed value: httpsOptions merged over setGlobalOptions.
      timeoutSeconds: () => fn.__endpoint.timeoutSeconds,
      region: () => resolveRegion(fn.__endpoint.region?.[0]),
    }),
  );
  return fn;
}
