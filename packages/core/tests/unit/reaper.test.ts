import {
  genkit,
  InMemorySessionStore,
  type SessionSnapshot,
  type SessionStore,
} from 'genkit/beta';
import { describe, expect, test } from 'vitest';
import {
  DEAD_HEARTBEAT_MS,
  isDeadDetachedRow,
  reapDeadTip,
  reapedSnapshot,
} from '../../src/reaper.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const row = (over: Partial<SessionSnapshot>): SessionSnapshot => ({
  snapshotId: 'tip',
  sessionId: 's1',
  parentId: 'parent',
  createdAt: ago(300_000),
  status: 'pending',
  heartbeatAt: ago(DEAD_HEARTBEAT_MS + 1),
  ...over,
});

describe('isDeadDetachedRow', () => {
  test.each(['pending', 'aborting'] as const)(
    'a %s row with a stale heartbeat is dead',
    (status) => {
      expect(isDeadDetachedRow(row({ status }), NOW)).toBe(true);
    },
  );

  test('a fresh heartbeat is alive', () => {
    expect(
      isDeadDetachedRow(row({ heartbeatAt: ago(DEAD_HEARTBEAT_MS - 1) }), NOW),
    ).toBe(false);
  });

  test.each(['completed', 'aborted', 'failed', undefined] as const)(
    'a %s row is never dead',
    (status) => {
      expect(isDeadDetachedRow(row({ status }), NOW)).toBe(false);
    },
  );

  test('without a heartbeat it falls back to the last write', () => {
    expect(
      isDeadDetachedRow(
        row({ heartbeatAt: undefined, updatedAt: ago(DEAD_HEARTBEAT_MS + 1) }),
        NOW,
      ),
    ).toBe(true);
    expect(
      isDeadDetachedRow(
        row({ heartbeatAt: undefined, createdAt: ago(1_000) }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe('reapedSnapshot', () => {
  test('settles as aborted with the parent state and no heartbeat', () => {
    const state = { sessionId: 's1', messages: [], artifacts: [] };
    const reaped = reapedSnapshot(row({}), state, NOW);
    expect(reaped).toMatchObject({
      snapshotId: 'tip',
      sessionId: 's1',
      parentId: 'parent',
      status: 'aborted',
      finishReason: 'aborted',
      state,
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(reaped).not.toHaveProperty('heartbeatAt');
    expect(reaped.error?.status).toBe('ABORTED');
  });

  test('uses an empty state when there is no parent', () => {
    expect(
      reapedSnapshot(row({ parentId: undefined }), undefined, NOW).state,
    ).toEqual({ sessionId: 's1', messages: [], artifacts: [] });
  });
});

describe('reapDeadTip re-checks inside the write', () => {
  test('leaves a row whose worker beat again after the read', async () => {
    const stale = row({
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const fresh = { ...stale, heartbeatAt: new Date().toISOString() };
    const written: unknown[] = [];
    const store: SessionStore = {
      getSnapshot: async (opts) =>
        opts.snapshotId === 'tip' || opts.sessionId ? stale : undefined,
      saveSnapshot: async (id, mutator) => {
        const result = mutator(fresh);
        if (result) written.push(result);
        return result ? (id ?? null) : null;
      },
    };
    expect(await reapDeadTip(store, 's1', {})).toBe(false);
    expect(written).toEqual([]);
  });
});

describe('reapDeadTip with a Genkit agent', () => {
  async function sessionWithDeadTip(heartbeatAge: number) {
    const ai = genkit({});
    ai.defineModel({ name: 'echo' }, async (req) => ({
      message: {
        role: 'model',
        content: [{ text: `n=${req.messages.length}` }],
      },
      finishReason: 'stop',
    }));
    const store = new InMemorySessionStore();
    const agent = ai.defineAgent({ name: 'a', model: 'echo', store });
    const first = await agent.run(
      { message: { role: 'user', content: [{ text: 'hi' }] } },
      { init: {} },
    );
    const sessionId = first.result.sessionId;
    const parentId = first.result.snapshotId;
    if (!sessionId || !parentId) throw new Error('no session');
    const now = Date.now();
    await store.saveSnapshot('dead', () => ({
      snapshotId: 'dead',
      sessionId,
      parentId,
      createdAt: new Date(now - 300_000).toISOString(),
      status: 'pending',
      heartbeatAt: new Date(now - heartbeatAge).toISOString(),
    }));
    const resume = (init: { sessionId?: string; snapshotId?: string }) =>
      agent.run(
        { message: { role: 'user', content: [{ text: 'again' }] } },
        { init },
      );
    return { store, sessionId, parentId, resume };
  }

  test('makes the session resumable by sessionId and by the dead row id', async () => {
    const { store, sessionId, parentId, resume } =
      await sessionWithDeadTip(120_000);
    const before = await resume({ sessionId });
    expect(before.result.finishReason).toBe('failed');

    expect(await reapDeadTip(store, sessionId, {})).toBe(true);
    const reaped = await store.getSnapshot({ snapshotId: 'dead' });
    const parent = await store.getSnapshot({ snapshotId: parentId });
    expect(reaped?.status).toBe('aborted');
    expect(reaped?.state).toEqual(parent?.state);

    const bySession = await resume({ sessionId });
    expect(bySession.result.finishReason).toBe('stop');
    const byRow = await resume({ snapshotId: 'dead' });
    expect(byRow.result.finishReason).toBe('stop');
  });

  test('leaves a live detached row alone', async () => {
    const { store, sessionId } = await sessionWithDeadTip(1_000);
    expect(await reapDeadTip(store, sessionId, {})).toBe(false);
    expect((await store.getSnapshot({ snapshotId: 'dead' }))?.status).toBe(
      'pending',
    );
  });
});
