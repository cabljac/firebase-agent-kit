import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GenkitError } from 'genkit';
import { genkit, InMemorySessionStore } from 'genkit/beta';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAgentApp } from '../../src/handler.js';
import type {
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
  };
  return { lock, released, acquired };
}

async function setup(
  opts: {
    lock?: TurnLock | false;
    timeoutSeconds?: number;
    uid?: string | null;
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
  const store = new InMemorySessionStore();
  const agent = ai.defineAgent({ name: 'testAgent', model: 'echo', store });
  const uid = opts.uid === undefined ? 'u1' : opts.uid;
  const app = createAgentApp(
    agent,
    {
      store,
      lock: opts.lock,
      beforeTurn: opts.beforeTurn,
      httpsOptions:
        opts.timeoutSeconds === undefined
          ? undefined
          : { timeoutSeconds: opts.timeoutSeconds },
    },
    { contextProvider: () => (uid ? { auth: { uid } } : {}) },
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

  test('runs beforeTurn only after authentication', async () => {
    const beforeTurn = vi.fn();
    const { post } = await setup({ beforeTurn, uid: null });
    const res = await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(res.status).toBe(401);
    expect(beforeTurn).not.toHaveBeenCalled();
  });

  test('passes the auth context to beforeTurn on turns only', async () => {
    const beforeTurn = vi.fn();
    const { lock } = fakeLock();
    const { post } = await setup({ beforeTurn, lock });
    await post('/', { data: turn(), init: { sessionId: 's1' } });
    await post('/getSnapshot', { data: { snapshotId: 'x' } });
    expect(beforeTurn).toHaveBeenCalledTimes(1);
    expect(beforeTurn).toHaveBeenCalledWith({ auth: { uid: 'u1' } });
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
    expect(acquired).toEqual([{ key: 'u1:s1', leaseMs: 150_000 }]);
    await vi.waitFor(() => expect(released).toEqual(['u1:s1']));
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
    const { lock, released } = fakeLock(true);
    const { post } = await setup({ lock });
    const res = await post('/', { data: turn(), init: { sessionId: 's1' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'ABORTED' });
    expect(released).toHaveLength(0);
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
    expect(acquired.map((a) => a.key)).toEqual(['u1:s1', 'u1:s1']);
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
    await vi.waitFor(() => expect(released).toEqual(['u1:s1']));
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
