import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { genkit, InMemorySessionStore } from 'genkit/beta';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('firebase-functions', () => ({ logger: { error: vi.fn() } }));
vi.mock('firebase-functions/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import {
  DETACH_LEASE_MS,
  type DetachDeps,
  defineDetachedTurns,
} from '../../src/detach.js';
import { createAgentApp } from '../../src/handler.js';
import { lockKey } from '../../src/keys.js';
import type {
  AgentRequestContext,
  TurnLease,
  TurnLock,
} from '../../src/types.js';
import { MemoryRunStore } from './fake-runs.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise((r) => s.close(() => r(undefined)))),
  );
});

/** An in-memory lock with real owner semantics. */
class MemoryLock implements TurnLock {
  readonly holders = new Map<string, string>();
  readonly acquired: Array<{ key: string; leaseMs: number; owner?: string }> =
    [];
  async acquire(
    key: string,
    opts: { leaseMs: number; owner?: string },
  ): Promise<TurnLease | null> {
    this.acquired.push({ key, ...opts });
    if (this.holders.has(key)) return null;
    const owner = opts.owner ?? 'random';
    this.holders.set(key, owner);
    return { key, owner, release: () => this.release(key, owner) };
  }
  async renew(key: string, owner: string) {
    return this.holders.get(key) === owner;
  }
  async release(key: string, owner: string) {
    if (this.holders.get(key) === owner) this.holders.delete(key);
  }
}

const token = {
  uid: 'u1',
  sub: 'u1',
  aud: 'demo-test',
  iss: 'https://securetoken.google.com/demo-test',
  iat: 0,
  exp: 0,
  auth_time: 0,
  firebase: { identities: {}, sign_in_provider: 'custom' },
};
const authContext: AgentRequestContext = {
  auth: { uid: 'u1', rawToken: 'raw', token },
};

type Worker = (runs: MemoryRunStore, runId: string) => void;

/** A worker that claims at once and reports a detached output. */
const prompt: Worker = (runs, runId) => {
  setTimeout(async () => {
    await runs.claim(runId, null);
    await runs.recordOutput(runId, {
      sessionId: 's1',
      snapshotId: 'snap1',
      finishReason: 'detached',
    });
  }, 5);
};

async function setup(
  opts: {
    worker?: Worker;
    enqueue?: DetachDeps['enqueue'];
    enabled?: boolean;
  } = {},
) {
  const ai = genkit({});
  ai.defineModel({ name: 'echo' }, async () => ({
    message: { role: 'model', content: [{ text: 'hi' }] },
    finishReason: 'stop',
  }));
  const store = new InMemorySessionStore();
  const agent = ai.defineAgent({ name: 'a', model: 'echo', store });
  const lock = new MemoryLock();
  const runs = new MemoryRunStore();
  const enqueued: Array<{ runId: string; deadline: number }> = [];
  let n = 0;
  const detach = defineDetachedTurns({
    queue: 'worker',
    store,
    lock,
    timeoutSeconds: 300,
    enabled: opts.enabled ?? true,
  });
  const app = createAgentApp(
    agent,
    { detach },
    {
      contextProvider: () => authContext,
      sleep: async () => {},
      detach: {
        runs,
        newRunId: () => `run${++n}`,
        claimWaitMs: 150,
        outputWaitMs: 150,
        enqueue:
          opts.enqueue ??
          (async (runId, deadline) => {
            enqueued.push({ runId, deadline });
            (opts.worker ?? prompt)(runs, runId);
          }),
      },
    },
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (
    body: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) =>
    fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  return { post, lock, runs, enqueued, store, agent };
}

const detachTurn = (text = 'hi') => ({
  data: { message: { role: 'user', content: [{ text }] }, detach: true },
  init: { sessionId: 's1' },
});
const KEY = lockKey('u1', 's1');
const detachedResult = {
  sessionId: 's1',
  snapshotId: 'snap1',
  finishReason: 'detached',
};

describe('detached turns on the turn route', () => {
  test('relays the detached output as JSON and hands the lock to the run', async () => {
    const { post, lock, runs, enqueued } = await setup();
    const res = await post(detachTurn());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: detachedResult });
    expect(lock.acquired[0]).toEqual({
      key: KEY,
      leaseMs: DETACH_LEASE_MS,
      owner: 'run1',
    });
    expect(lock.holders.get(KEY)).toBe('run1');
    expect(enqueued).toEqual([{ runId: 'run1', deadline: 300 }]);
    expect(runs.docs.get('run1')).toMatchObject({
      uid: 'u1',
      lockKey: KEY,
      instanceId: null,
      status: 'detached',
    });
  });

  test('writes one SSE frame for a streaming request, like @genkit-ai/express', async () => {
    const { post } = await setup();
    const res = await post(detachTurn(), { accept: 'text/event-stream' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(
      `data: ${JSON.stringify({ result: detachedResult })}\n\n`,
    );
  });

  test('stores the claims and the input on the run, never the raw token', async () => {
    const { post, runs } = await setup();
    const create = vi.spyOn(runs, 'create');
    await post(detachTurn());
    const run = create.mock.calls[0]?.[1];
    expect(run?.claims).toEqual(token);
    expect(run?.input.message?.content).toEqual([{ text: 'hi' }]);
    expect(JSON.stringify(run)).not.toContain('raw');
  });

  test('gives a new session an id, so the run is locked', async () => {
    const { post, runs, lock } = await setup();
    const create = vi.spyOn(runs, 'create');
    const res = await post({
      data: detachTurn().data,
    });
    expect(res.status).toBe(200);
    const sessionId = create.mock.calls[0]?.[1].init?.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lock.acquired[0]?.key).toBe(lockKey('u1', sessionId ?? ''));
  });

  test('answers 400 FAILED_PRECONDITION when detached turns are off', async () => {
    const { post, enqueued } = await setup({ enabled: false });
    const res = await post(detachTurn());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'FAILED_PRECONDITION' });
    expect(enqueued).toHaveLength(0);
  });

  test('answers 400 INVALID_ARGUMENT for a run over the Firestore limit', async () => {
    const { post, lock } = await setup();
    const res = await post(detachTurn('x'.repeat(1_100_000)));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'INVALID_ARGUMENT' });
    expect(lock.acquired).toHaveLength(0);
  });

  test('answers 409 after retrying a busy lock', async () => {
    const { post, lock, runs } = await setup();
    lock.holders.set(KEY, 'other');
    const res = await post(detachTurn());
    expect(res.status).toBe(409);
    expect(lock.acquired).toHaveLength(5);
    expect(runs.docs.size).toBe(0);
  });

  test('takes a lock that frees up during the retries', async () => {
    const { post, lock } = await setup();
    lock.holders.set(KEY, 'other');
    const acquire = lock.acquire.bind(lock);
    vi.spyOn(lock, 'acquire').mockImplementation(async (key, opts) => {
      if (lock.acquired.length === 2) lock.holders.delete(KEY);
      return acquire(key, opts);
    });
    expect((await post(detachTurn())).status).toBe(200);
  });

  test('cancels the run and releases the lock when the enqueue fails', async () => {
    const { post, lock, runs } = await setup({
      enqueue: async () => {
        throw new Error('queue missing');
      },
    });
    const res = await post(detachTurn());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'UNAVAILABLE' });
    expect(runs.docs.get('run1')).toMatchObject({ status: 'cancelled' });
    expect(runs.docs.get('run1')).not.toHaveProperty('input');
    expect(lock.holders.size).toBe(0);
  });

  test('cancels an unclaimed run and releases the lock after the claim wait', async () => {
    const { post, lock, runs } = await setup({ worker: () => {} });
    const res = await post(detachTurn());
    expect(res.status).toBe(503);
    expect(runs.docs.get('run1')?.status).toBe('cancelled');
    expect(lock.holders.size).toBe(0);
  });

  test('abandons a claimed run without output after the output wait, keeping the lock for the worker', async () => {
    const { post, lock, runs } = await setup({
      worker: (r, runId) => void r.claim(runId, null),
    });
    const res = await post(detachTurn());
    expect(res.status).toBe(503);
    expect(runs.docs.get('run1')?.status).toBe('abandoned');
    expect(lock.holders.get(KEY)).toBe('run1');
  });

  test('cancels a queued run and releases the lock when the client goes away', async () => {
    const { post, lock, runs } = await setup({ worker: () => {} });
    const controller = new AbortController();
    const request = post(detachTurn(), {}, controller.signal);
    await vi.waitFor(() => expect(runs.docs.get('run1')).toBeDefined());
    controller.abort();
    await expect(request).rejects.toThrow();
    await vi.waitFor(() =>
      expect(runs.docs.get('run1')?.status).toBe('cancelled'),
    );
    expect(lock.holders.size).toBe(0);
  });

  test('relays the error of a run the worker refused', async () => {
    const { post } = await setup({
      worker: (runs, runId) => {
        setTimeout(async () => {
          await runs.claim(runId, null);
          await runs.finish(runId, 'cancelled', {
            error: { status: 'PERMISSION_DENIED', message: 'disabled' },
          });
        }, 5);
      },
    });
    const res = await post(detachTurn());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: 'PERMISSION_DENIED' });
  });

  test('rejects a lock option next to detach', () => {
    const ai = genkit({});
    const store = new InMemorySessionStore();
    const agent = ai.defineAgent({ name: 'b', store });
    expect(() =>
      createAgentApp(agent, {
        lock: false,
        detach: defineDetachedTurns({
          queue: 'w',
          store,
          lock: new MemoryLock(),
        }),
      }),
    ).toThrow(/lock/);
  });
});

describe('the reaper on the turn route', () => {
  test('settles a dead detached tip before an attached turn runs', async () => {
    const { post, store, agent } = await setup();
    const first = await agent.run(
      { message: { role: 'user', content: [{ text: 'a' }] } },
      { init: { sessionId: 's1' } },
    );
    const now = Date.now();
    await store.saveSnapshot('dead', () => ({
      snapshotId: 'dead',
      sessionId: 's1',
      parentId: first.result.snapshotId,
      createdAt: new Date(now - 300_000).toISOString(),
      status: 'pending',
      heartbeatAt: new Date(now - 120_000).toISOString(),
    }));
    const res = await post({
      data: { message: { role: 'user', content: [{ text: 'b' }] } },
      init: { snapshotId: 'dead' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result.finishReason).toBe('stop');
    expect((await store.getSnapshot({ snapshotId: 'dead' }))?.status).toBe(
      'aborted',
    );
  });
});
