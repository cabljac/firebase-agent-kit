import type { DecodedIdToken } from 'firebase-admin/auth';
import { GenkitError } from 'genkit';
import type { AgentOutput } from 'genkit/beta';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('firebase-functions/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import { RENEW_INTERVAL_MS, WORKER_LEASE_MS } from '../../src/detach.js';
import type { AgentAuthContext, TurnLock } from '../../src/types.js';
import {
  runDetachedTask,
  SELF_ABORT_MARGIN_MS,
  type TaskAgent,
  type WorkerDeps,
} from '../../src/worker.js';
import { MemoryRunStore } from './fake-runs.js';

const claims: DecodedIdToken = {
  uid: 'u1',
  sub: 'u1',
  aud: 'demo',
  iss: 'iss',
  iat: 1_000,
  exp: 4_600,
  auth_time: 1_000,
  firebase: { identities: {}, sign_in_provider: 'password' },
  plan: 'old',
};

const detachedOutput: AgentOutput = {
  sessionId: 's1',
  snapshotId: 'snap1',
  finishReason: 'detached',
};

function fakeLock(renewResults: Array<boolean | Error> = []) {
  const calls = { renew: 0, released: [] as string[] };
  const lock: TurnLock = {
    acquire: async () => null,
    renew: async () => {
      const next = renewResults[calls.renew++] ?? true;
      if (next instanceof Error) throw next;
      return next;
    },
    release: async (key, owner) => {
      calls.released.push(`${key}/${owner}`);
    },
  };
  return { lock, calls };
}

function fakeAgent(opts: { output?: AgentOutput; fail?: unknown } = {}) {
  let settle: (s: { status: string; finishReason: string }) => void = () => {};
  const settled = new Promise<{ status: string; finishReason: string }>(
    (resolve) => {
      settle = resolve;
    },
  );
  const contexts: AgentAuthContext[] = [];
  const agent = {
    runTurn: vi.fn(async (_input, _init, context: AgentAuthContext) => {
      contexts.push(context);
      if (opts.fail) throw opts.fail;
      return opts.output ?? detachedOutput;
    }),
    abort: vi.fn(async () => {
      settle({ status: 'aborted', finishReason: 'aborted' });
      return 'pending';
    }),
    waitForSettled: vi.fn(async () => settled),
  } satisfies TaskAgent;
  return {
    agent,
    contexts,
    complete: () => settle({ status: 'completed', finishReason: 'stop' }),
  };
}

async function setup(
  over: Partial<WorkerDeps> & { instanceId?: string | null } = {},
) {
  const runs = new MemoryRunStore();
  await runs.create('r1', {
    uid: 'u1',
    instanceId: null,
    lockKey: 'key1',
    input: { message: { role: 'user', content: [{ text: 'hi' }] } },
    init: { sessionId: 's1' },
    claims,
  });
  const { lock, calls } = fakeLock();
  const deps: WorkerDeps = {
    runs,
    lock,
    agent: fakeAgent().agent,
    getUser: async () => ({
      disabled: false,
      tokensValidAfterTime: undefined,
      customClaims: { plan: 'new' },
    }),
    instanceId: null,
    timeoutSeconds: 600,
    now: Date.now,
    ...over,
  };
  return { runs, deps, calls };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runDetachedTask', () => {
  test('runs the turn with refreshed claims, records the output and the final status, and releases the lock', async () => {
    const { agent, contexts, complete } = fakeAgent();
    const { runs, deps, calls } = await setup({ agent });
    const done = runDetachedTask('r1', deps);
    await flush();
    expect(runs.docs.get('r1')).toMatchObject({
      status: 'detached',
      output: detachedOutput,
    });
    expect(runs.docs.get('r1')).not.toHaveProperty('input');
    expect(runs.docs.get('r1')).not.toHaveProperty('claims');
    complete();
    await done;
    expect(agent.runTurn).toHaveBeenCalledWith(
      { message: { role: 'user', content: [{ text: 'hi' }] } },
      { sessionId: 's1' },
      expect.anything(),
    );
    expect(contexts[0]?.auth.token.plan).toBe('new');
    expect(contexts[0]?.auth).not.toHaveProperty('rawToken');
    expect(runs.docs.get('r1')).toMatchObject({
      status: 'done',
      final: { status: 'completed', finishReason: 'stop' },
    });
    expect(calls.released).toEqual(['key1/r1']);
  });

  test('refuses a run that is not queued, without touching the lock', async () => {
    const { agent } = fakeAgent();
    const { runs, deps, calls } = await setup({ agent });
    runs.update('r1', { status: 'running' });
    await runDetachedTask('r1', deps);
    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(calls.renew).toBe(0);
    expect(calls.released).toEqual([]);
  });

  test('a second delivery of the same run is refused', async () => {
    const { agent, complete } = fakeAgent();
    const { deps } = await setup({ agent });
    const first = runDetachedTask('r1', deps);
    await flush();
    await runDetachedTask('r1', deps);
    complete();
    await first;
    expect(agent.runTurn).toHaveBeenCalledTimes(1);
  });

  test('refuses a run of another instance', async () => {
    const { agent } = fakeAgent();
    const { runs, deps } = await setup({ agent, instanceId: 'other' });
    await runDetachedTask('r1', deps);
    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(runs.docs.get('r1')?.status).toBe('queued');
  });

  test('cancels the run when it does not hold the lock at claim time', async () => {
    const { agent } = fakeAgent();
    const { lock, calls } = fakeLock([false]);
    const { runs, deps } = await setup({ agent, lock });
    await runDetachedTask('r1', deps);
    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(runs.docs.get('r1')).toMatchObject({
      status: 'cancelled',
      error: { status: 'ABORTED' },
    });
    expect(calls.released).toEqual([]);
  });

  test.each([
    ['deleted', undefined, 'UNAUTHENTICATED'],
    [
      'disabled',
      { disabled: true, tokensValidAfterTime: undefined, customClaims: {} },
      'PERMISSION_DENIED',
    ],
    [
      'revoked',
      {
        disabled: false,
        tokensValidAfterTime: new Date(2_000_000).toUTCString(),
        customClaims: {},
      },
      'UNAUTHENTICATED',
    ],
  ])(
    'cancels the run of a %s user without running it and releases the lock',
    async (_name, user, status) => {
      const { agent } = fakeAgent();
      const { runs, deps, calls } = await setup({
        agent,
        getUser: async () => user,
      });
      await runDetachedTask('r1', deps);
      expect(agent.runTurn).not.toHaveBeenCalled();
      expect(runs.docs.get('r1')).toMatchObject({
        status: 'cancelled',
        error: { status },
      });
      expect(calls.released).toEqual(['key1/r1']);
    },
  );

  test('records a failed run when the turn throws', async () => {
    const { agent } = fakeAgent({
      fail: new GenkitError({ status: 'NOT_FOUND', message: 'gone' }),
    });
    const { runs, deps, calls } = await setup({ agent });
    await runDetachedTask('r1', deps);
    expect(runs.docs.get('r1')).toMatchObject({
      status: 'failed',
      error: { status: 'NOT_FOUND', message: 'gone' },
    });
    expect(calls.released).toEqual(['key1/r1']);
  });

  test('renews the lease every 30 seconds while the turn runs', async () => {
    const { agent, complete } = fakeAgent();
    const { lock, calls } = fakeLock();
    const renew = vi.spyOn(lock, 'renew');
    const { deps } = await setup({ agent, lock });
    const done = runDetachedTask('r1', deps);
    await flush();
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS * 2);
    expect(calls.renew).toBe(3);
    expect(renew).toHaveBeenCalledWith('key1', 'r1', WORKER_LEASE_MS);
    complete();
    await done;
  });

  test('aborts the turn when a renewal finds the lock lost (fencing)', async () => {
    const { agent } = fakeAgent();
    const { lock } = fakeLock([true, false]);
    const { runs, deps } = await setup({ agent, lock });
    const done = runDetachedTask('r1', deps);
    await flush();
    expect(agent.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);
    await done;
    expect(agent.abort).toHaveBeenCalledWith('snap1', expect.anything());
    expect(runs.docs.get('r1')?.final?.status).toBe('aborted');
  });

  test('a renewal error is logged, not thrown, and does not abort the turn', async () => {
    const { agent, complete } = fakeAgent();
    const { lock } = fakeLock([true, new Error('network')]);
    const { deps } = await setup({ agent, lock });
    const done = runDetachedTask('r1', deps);
    await flush();
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS);
    expect(agent.abort).not.toHaveBeenCalled();
    complete();
    await done;
  });

  test('aborts the turn shortly before the worker deadline', async () => {
    const { agent } = fakeAgent();
    const { deps } = await setup({ agent, timeoutSeconds: 60 });
    const done = runDetachedTask('r1', deps);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000 - SELF_ABORT_MARGIN_MS - 100);
    expect(agent.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(agent.abort).toHaveBeenCalledTimes(1);
  });

  test('aborts the turn when the turn route abandoned the run, and marks it cancelled', async () => {
    const { agent } = fakeAgent();
    const { runs, deps, calls } = await setup({ agent });
    const runTurn = agent.runTurn.getMockImplementation();
    agent.runTurn.mockImplementation(async (input, init, context) => {
      runs.update('r1', { status: 'abandoned' });
      if (!runTurn) throw new Error('no impl');
      return runTurn(input, init, context);
    });
    await runDetachedTask('r1', deps);
    expect(agent.abort).toHaveBeenCalledWith('snap1', expect.anything());
    expect(runs.docs.get('r1')).toMatchObject({
      status: 'cancelled',
      final: { status: 'aborted' },
    });
    expect(calls.released).toEqual(['key1/r1']);
  });

  test('a lock lost before the output exists aborts the turn once it does', async () => {
    const { agent } = fakeAgent();
    const { lock } = fakeLock([true, false]);
    const { deps } = await setup({ agent, lock });
    const runTurn = agent.runTurn.getMockImplementation();
    agent.runTurn.mockImplementation(async (input, init, context) => {
      await new Promise((r) => setTimeout(r, RENEW_INTERVAL_MS + 1));
      if (!runTurn) throw new Error('no impl');
      return runTurn(input, init, context);
    });
    const done = runDetachedTask('r1', deps);
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS + 10);
    await done;
    expect(agent.abort).toHaveBeenCalledTimes(1);
  });
});
