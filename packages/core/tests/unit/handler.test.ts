import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GenkitError } from 'genkit';
import { genkit, InMemorySessionStore } from 'genkit/beta';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAgentApp } from '../../src/handler.js';
import type {
  AgentRequestContext,
  AgentRequestOptions,
  TurnLease,
  TurnLock,
} from '../../src/types.js';

vi.mock('firebase-functions', () => ({ logger: { error: vi.fn() } }));

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise((r) => s.close(() => r(undefined)))),
  );
});

function fakeLock(held = false) {
  const released: string[] = [];
  const acquired: Array<{ key: string; leaseMs: number }> = [];
  const lock: TurnLock = {
    acquire: async (key, { leaseMs }) => {
      acquired.push({ key, leaseMs });
      if (held) return null;
      const lease: TurnLease = {
        key,
        owner: 'o',
        release: async () => {
          released.push(key);
        },
      };
      return lease;
    },
    renew: async () => true,
    release: async (key) => {
      released.push(key);
    },
  };
  return { lock, released, acquired };
}

async function setup(
  opts: {
    lock?: TurnLock | false;
    timeoutSeconds?: number;
    uid?: string | null;
    withoutRawToken?: boolean;
    authorize?: AgentRequestOptions['authorize'];
    beforeTurn?: AgentRequestOptions['beforeTurn'];
  } = {},
) {
  const ai = genkit({});
  ai.defineModel({ name: 'echo' }, async (req) => ({
    message: {
      role: 'model',
      content: [
        { text: `echo: ${JSON.stringify(req.messages.at(-1)?.content)}` },
      ],
    },
    finishReason: 'stop',
  }));
  const agent = ai.defineAgent({
    name: 'testAgent',
    model: 'echo',
    store: new InMemorySessionStore(),
  });
  const uid = opts.uid === undefined ? 'u1' : opts.uid;
  const app = createAgentApp(
    agent,
    {
      lock: opts.lock,
      authorize: opts.authorize,
      beforeTurn: opts.beforeTurn,
      httpsOptions:
        opts.timeoutSeconds === undefined
          ? undefined
          : { timeoutSeconds: opts.timeoutSeconds },
    },
    {
      contextProvider: () => {
        if (!uid) return {};
        if (!opts.withoutRawToken) return authContext(uid);
        const { auth } = authContext(uid);
        return { auth: { uid: auth.uid, token: auth.token } };
      },
      sleep: async () => {},
    },
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { post, base, server };
}

function authContext(uid: string): AgentRequestContext {
  return {
    auth: {
      uid,
      rawToken: `token-${uid}`,
      token: {
        uid,
        sub: uid,
        aud: 'demo-test',
        iss: 'https://securetoken.google.com/demo-test',
        iat: 0,
        exp: 0,
        auth_time: 0,
        firebase: { identities: {}, sign_in_provider: 'custom' },
      },
    },
  };
}

const U1_S1 = `${createHash('sha256').update('[null,"u1"]').digest('hex')}:s1`;

const routes = [
  ['/', 'turn'],
  ['/getSnapshot', 'getSnapshot'],
  ['/waitForSnapshot', 'waitForSnapshot'],
  ['/abort', 'abort'],
] as const;

const turn = (text = 'hi') => ({
  message: { role: 'user', content: [{ text }] },
});

describe('createAgentApp', () => {
  test('rejects unauthenticated requests on every route', async () => {
    const { lock } = fakeLock();
    const { post } = await setup({ lock, uid: null });
    for (const path of ['/', '/getSnapshot', '/waitForSnapshot', '/abort']) {
      const res = await post(path, { data: path === '/' ? turn() : {} });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toMatchObject({ status: 'UNAUTHENTICATED' });
    }
  });

  test('runs authorize and beforeTurn only after authentication', async () => {
    const authorize = vi.fn();
    const beforeTurn = vi.fn();
    const { post } = await setup({ authorize, beforeTurn, uid: null });
    const res = await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(res.status).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    expect(beforeTurn).not.toHaveBeenCalled();
  });

  test('runs authorize on every route with the route and the auth context', async () => {
    const authorize = vi.fn();
    const { lock } = fakeLock();
    const { post } = await setup({ authorize, lock });
    for (const [path] of routes) {
      await post(path, {
        data: path === '/' ? turn() : { snapshotId: 'x' },
        init: { sessionId: 's1' },
      });
    }
    expect(authorize.mock.calls).toEqual(
      routes.map(([, route]) => [{ route, context: authContext('u1') }]),
    );
  });

  test('rejects every route with the authorize error before beforeTurn and the lock', async () => {
    const beforeTurn = vi.fn();
    const { lock, acquired } = fakeLock();
    const { post } = await setup({
      lock,
      beforeTurn,
      authorize: () => {
        throw new GenkitError({ status: 'PERMISSION_DENIED', message: 'no' });
      },
    });
    for (const [path] of routes) {
      const res = await post(path, {
        data: path === '/' ? turn() : { snapshotId: 'x' },
        init: { sessionId: 's1' },
      });
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toEqual({
        status: 'PERMISSION_DENIED',
        message: 'no',
      });
    }
    expect(beforeTurn).not.toHaveBeenCalled();
    expect(acquired).toHaveLength(0);
  });

  test('passes the context, input and init to beforeTurn on turns only', async () => {
    const beforeTurn = vi.fn();
    const { lock } = fakeLock();
    const { post } = await setup({ beforeTurn, lock });
    await post('/', { data: turn(), init: { sessionId: 's1' } });
    await post('/getSnapshot', { data: { snapshotId: 'x' } });
    expect(beforeTurn.mock.calls).toEqual([
      [
        {
          context: authContext('u1'),
          input: turn(),
          init: { sessionId: 's1' },
        },
      ],
    ]);
  });

  test('passes an undefined init to beforeTurn when the request has none', async () => {
    const beforeTurn = vi.fn();
    const { post } = await setup({ beforeTurn });
    await post('/', { data: turn() });
    expect(beforeTurn.mock.calls[0]?.[0]).toMatchObject({ init: undefined });
  });

  test.each([
    ['input', { data: { message: 'hi' } }],
    ['init', { data: turn(), init: { sessionId: 5 } }],
  ])(
    'answers 400 INVALID_ARGUMENT for a malformed turn %s before beforeTurn',
    async (_part, body) => {
      const beforeTurn = vi.fn();
      const { lock, acquired } = fakeLock();
      const { post } = await setup({ beforeTurn, lock });
      const res = await post('/', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ status: 'INVALID_ARGUMENT' });
      expect(beforeTurn).not.toHaveBeenCalled();
      expect(acquired).toHaveLength(0);
    },
  );

  test('runs beforeTurn before the detach guard rejects the turn', async () => {
    const beforeTurn = vi.fn();
    const { post } = await setup({ beforeTurn });
    const res = await post('/', {
      data: { ...turn(), detach: true },
      init: { sessionId: 's1' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'FAILED_PRECONDITION' });
    expect(beforeTurn).toHaveBeenCalledTimes(1);
  });

  test('runs authorize before the turn body is parsed', async () => {
    const { post } = await setup({
      authorize: () => {
        throw new GenkitError({ status: 'PERMISSION_DENIED', message: 'no' });
      },
    });
    const res = await post('/', { data: { message: 'hi' } });
    expect(res.status).toBe(403);
  });

  test('rejects the turn with the beforeTurn error before taking the lock', async () => {
    const { lock, acquired } = fakeLock();
    const { post } = await setup({
      lock,
      beforeTurn: () => {
        throw new GenkitError({
          status: 'FAILED_PRECONDITION',
          message: 'misconfigured',
        });
      },
    });
    const res = await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      status: 'FAILED_PRECONDITION',
      message: 'misconfigured',
    });
    expect(acquired).toHaveLength(0);
  });

  test.each([
    ['authorize', '/getSnapshot'],
    ['beforeTurn', '/'],
  ] as const)(
    'answers a hidden 500 when %s throws a non-Genkit error',
    async (hook, path) => {
      const fail = () => {
        throw new Error('secret');
      };
      const { post } = await setup({ [hook]: fail });
      const res = await post(path, {
        data: path === '/' ? turn() : { snapshotId: 'x' },
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        status: 'INTERNAL',
        message: 'Internal Error',
      });
    },
  );

  test('rejects detached turns', async () => {
    const { lock, acquired } = fakeLock();
    const { post } = await setup({ lock });
    const res = await post('/', {
      data: { ...turn(), detach: true },
      init: { sessionId: 's1' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'FAILED_PRECONDITION' });
    expect(acquired).toHaveLength(0);
  });

  test('runs a normal turn and releases the lease after the response', async () => {
    const { lock, released, acquired } = fakeLock();
    const { post } = await setup({ lock, timeoutSeconds: 120 });
    const res = await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { message: unknown } };
    expect(JSON.stringify(body.result.message)).toContain('echo');
    expect(acquired).toEqual([{ key: U1_S1, leaseMs: 150_000 }]);
    await vi.waitFor(() => expect(released).toEqual([U1_S1]));
  });

  test('uses a 60 second timeout for the default lease', async () => {
    const { lock, acquired } = fakeLock();
    const { post } = await setup({ lock });
    await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(acquired[0]?.leaseMs).toBe(90_000);
  });

  test('does not lock a new session', async () => {
    const { lock, acquired } = fakeLock();
    const { post } = await setup({ lock });
    const res = await post('/', { data: turn(), init: {} });
    expect(res.status).toBe(200);
    expect(acquired).toHaveLength(0);
  });

  test('answers 409 ABORTED when the session lock is held', async () => {
    const { lock, released, acquired } = fakeLock(true);
    const { post } = await setup({ lock });
    const res = await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'ABORTED' });
    expect(released).toHaveLength(0);
    expect(acquired).toHaveLength(5);
  });

  test('retries a busy lock and runs the turn once it frees', async () => {
    const { lock, acquired } = fakeLock();
    const acquire = lock.acquire.bind(lock);
    let busy = 2;
    vi.spyOn(lock, 'acquire').mockImplementation(async (key, opts) => {
      const lease = await acquire(key, opts);
      return busy-- > 0 ? null : lease;
    });
    const { post } = await setup({ lock });
    const res = await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(res.status).toBe(200);
    expect(acquired).toHaveLength(3);
  });

  test('answers 401 to a context without the raw ID token', async () => {
    const { lock, acquired } = fakeLock();
    const { post } = await setup({ lock, withoutRawToken: true });
    const res = await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(res.status).toBe(401);
    expect(acquired).toHaveLength(0);
  });

  test('skips locking when lock is false', async () => {
    const { post } = await setup({ lock: false });
    const res = await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(res.status).toBe(200);
  });

  test('serves the companion routes', async () => {
    const { lock } = fakeLock();
    const { post } = await setup({ lock });
    const first = await post('/', { data: turn(), init: { sessionId: 's1' } });
    const { result } = (await first.json()) as {
      result: { snapshotId: string };
    };

    const snap = await post('/getSnapshot', {
      data: { snapshotId: result.snapshotId },
    });
    expect(snap.status).toBe(200);
    expect(await snap.json()).toMatchObject({
      result: { snapshotId: result.snapshotId },
    });

    const wait = await post('/waitForSnapshot', {
      data: { snapshotId: result.snapshotId },
    });
    expect(wait.status).toBe(200);

    const abort = await post('/abort', {
      data: { snapshotId: result.snapshotId },
    });
    expect(abort.status).toBe(200);
  });

  test('locks a snapshotId resume by its session', async () => {
    const { lock, acquired } = fakeLock();
    const { post } = await setup({ lock });
    const first = await post('/', { data: turn(), init: { sessionId: 's1' } });
    const { result } = (await first.json()) as {
      result: { snapshotId: string };
    };
    const second = await post('/', {
      data: turn('again'),
      init: { snapshotId: result.snapshotId },
    });
    expect(second.status).toBe(200);
    expect(acquired.map((a) => a.key)).toEqual([U1_S1, U1_S1]);
  });

  test('releases the lease when the client disconnects while acquire is pending', async () => {
    const released: string[] = [];
    let markAcquireStarted = () => {};
    let finishAcquire = () => {};
    const acquireStarted = new Promise<void>((resolve) => {
      markAcquireStarted = resolve;
    });
    const acquireGate = new Promise<void>((resolve) => {
      finishAcquire = resolve;
    });
    const lock: TurnLock = {
      acquire: async (key) => {
        markAcquireStarted();
        await acquireGate;
        return {
          key,
          owner: 'o',
          release: async () => {
            released.push(key);
          },
        };
      },
      renew: async () => true,
      release: async () => {},
    };
    const { base, server } = await setup({ lock });
    const socketClosed = new Promise<void>((resolve) => {
      server.once('connection', (socket) => {
        socket.once('close', () => resolve());
      });
    });

    const controller = new AbortController();
    const request = fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: turn(), init: { sessionId: 's1' } }),
      signal: controller.signal,
    });
    await acquireStarted;
    controller.abort();
    await expect(request).rejects.toThrow('aborted');
    await socketClosed;
    await new Promise((resolve) => setImmediate(resolve));

    finishAcquire();
    await vi.waitFor(() => expect(released).toEqual([U1_S1]));
  });

  test('answers 400 for a malformed JSON body', async () => {
    const { lock } = fakeLock();
    const { base } = await setup({ lock });
    const res = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
  });
});
