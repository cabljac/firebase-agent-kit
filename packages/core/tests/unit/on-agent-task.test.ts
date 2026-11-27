import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { genkit, InMemorySessionStore } from 'genkit/beta';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { detachedTurnsHandle } from '../../src/detached-turns.js';
import type { TurnLock } from '../../src/types.js';
import { onAgentTask } from '../../src/worker.js';

vi.mock('firebase-functions/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
});

const lock: TurnLock = {
  acquire: async () => null,
  renew: async () => false,
  release: async () => {},
};

function worker(ready: () => Promise<void>) {
  const store = new InMemorySessionStore();
  const agent = genkit({}).defineAgent({ name: 'taskAgent', store });
  const enabled = vi.fn(() => false);
  const handle = detachedTurnsHandle({
    queue: 'agentWorker',
    store,
    instanceId: null,
    lock,
    runsCollection: 'runs',
    enabled,
    timeoutSeconds: () => 540,
    functionTimeout: 540,
    firestore: (): Firestore => {
      throw new Error('Firestore is not used by these tests.');
    },
  });
  const fn = onAgentTask(agent, handle, { ready });
  const run = () =>
    fn.run({ data: { runId: 'r1' } } as Parameters<typeof fn.run>[0]);
  return { run, enabled };
}

describe('onAgentTask ready', () => {
  test('waits for ready before it handles a task', async () => {
    let resolveReady = () => {};
    const ready = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReady = resolve;
        }),
    );
    const { run, enabled } = worker(ready);
    const pending = run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ready).toHaveBeenCalledOnce();
    expect(enabled).not.toHaveBeenCalled();
    resolveReady();
    await pending;
    expect(enabled).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'Detached turns are off; refused run r1.',
    );
  });

  test('fails the task and handles nothing when ready rejects', async () => {
    const err = new Error('no credentials');
    const { run, enabled } = worker(async () => {
      throw err;
    });
    await expect(run()).rejects.toBe(err);
    expect(enabled).not.toHaveBeenCalled();
  });
});
