import { expressHandler } from '@genkit-ai/express';
import { firebaseContext } from '@genkit-ai/firebase/context';
import express from 'express';
import { onRequest } from 'firebase-functions/v2/https';
import { GenkitError } from 'genkit';
import type { ActionContext, Agent } from 'genkit/beta';
import type { ContextProvider, RequestData } from 'genkit/context';
import {
  assertNotDetach,
  requireUid,
  resolveLockKey,
  sendError,
} from './guards.js';
import { FirestoreTurnLock } from './lock.js';
import type { AgentRequestOptions, TurnLease, TurnLock } from './types.js';

/** Test seams for {@link createAgentApp}. */
export interface AgentAppDeps {
  /** Replaces the Firebase auth context provider. */
  contextProvider?: ContextProvider<ActionContext>;
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
  opts: AgentRequestOptions<S>,
  deps: AgentAppDeps = {},
): express.Express {
  const contextProvider: ContextProvider<ActionContext> =
    deps.contextProvider ??
    firebaseContext({
      signedIn: true,
      ...(opts.enforceAppCheck ? { enforceAppCheck: true } : {}),
    });
  const timeoutSeconds = opts.httpsOptions?.timeoutSeconds;
  const leaseMs =
    (typeof timeoutSeconds === 'number'
      ? timeoutSeconds
      : DEFAULT_TIMEOUT_SECONDS) *
      1000 +
    LEASE_GRACE_MS;

  let defaultLock: TurnLock | undefined;
  const getLock = (): TurnLock => {
    if (opts.lock) return opts.lock;
    defaultLock ??= new FirestoreTurnLock();
    return defaultLock;
  };

  const route =
    (
      action: Parameters<typeof expressHandler>[0],
      withLock: boolean,
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
        requireUid(ctx);
        if (withLock) {
          await opts.beforeTurn?.(ctx);
          assertNotDetach(req.body?.data);
          const key = await resolveLockKey(req.body?.init, opts.store, ctx);
          if (key && opts.lock !== false) {
            lease = await getLock().acquire(key, { leaseMs });
            if (!lease) {
              throw new GenkitError({
                status: 'ABORTED',
                message: 'Another turn is running for this session.',
              });
            }
            if (closed) {
              void lease.release();
              lease = null;
            }
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
  app.post('/', route(agent, true));
  app.post('/getSnapshot', route(agent.getSnapshotDataAction, false));
  app.post('/waitForSnapshot', route(agent.waitForSnapshotAction, false));
  app.post('/abort', route(agent.abortAgentAction, false));
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
  opts: AgentRequestOptions<S>,
): ReturnType<typeof onRequest> {
  return onRequest(opts.httpsOptions ?? {}, createAgentApp(agent, opts));
}
