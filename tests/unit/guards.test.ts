import type { Response } from 'express';
import { GenkitError } from 'genkit';
import type { ActionContext, SessionSnapshot, SessionStore } from 'genkit/beta';
import { describe, expect, test, vi } from 'vitest';

vi.mock('firebase-functions', () => ({ logger: { error: vi.fn() } }));

import { logger } from 'firebase-functions';
import {
  assertNotDetach,
  requireUid,
  resolveLockKey,
  sendError,
} from '../../src/guards.js';

function fakeStore(snapshots: Record<string, SessionSnapshot>) {
  const getSnapshot = vi.fn(
    async (opts: {
      snapshotId?: string;
    }): Promise<SessionSnapshot | undefined> =>
      opts.snapshotId ? snapshots[opts.snapshotId] : undefined,
  );
  const store: SessionStore = {
    getSnapshot,
    saveSnapshot: async () => {
      throw new Error('not used');
    },
  };
  return { store, getSnapshot };
}

const ctx: ActionContext = { auth: { uid: 'u1' } };

describe('assertNotDetach', () => {
  test('throws FAILED_PRECONDITION when detach is true', () => {
    expect(() => assertNotDetach({ detach: true })).toThrowError(GenkitError);
    try {
      assertNotDetach({ detach: true });
    } catch (e) {
      expect(e).toBeInstanceOf(GenkitError);
      expect((e as GenkitError).status).toBe('FAILED_PRECONDITION');
      expect((e as GenkitError).code).toBe(400);
    }
  });

  test.each([
    [undefined],
    [null],
    ['x'],
    [{}],
    [{ detach: false }],
    [{ detach: 'true' }],
  ])('allows %j', (input) => {
    expect(() => assertNotDetach(input)).not.toThrow();
  });
});

describe('requireUid', () => {
  test('returns the uid', () => {
    expect(requireUid(ctx)).toBe('u1');
  });

  test.each([
    [undefined],
    [{}],
    [{ auth: {} }],
    [{ auth: { uid: '' } }],
    [{ auth: { uid: 5 } }],
  ])('throws UNAUTHENTICATED for %j', (c) => {
    try {
      requireUid(c);
      expect.unreachable();
    } catch (e) {
      expect((e as GenkitError).status).toBe('UNAUTHENTICATED');
      expect((e as GenkitError).code).toBe(401);
    }
  });
});

describe('resolveLockKey', () => {
  test('uses sessionId directly without reading the store', async () => {
    const { store, getSnapshot } = fakeStore({});
    await expect(resolveLockKey({ sessionId: 's1' }, store, ctx)).resolves.toBe(
      'u1:s1',
    );
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  test('resolves snapshotId first when both ids are present', async () => {
    const { store, getSnapshot } = fakeStore({
      snap: { snapshotId: 'snap', sessionId: 's1' } as SessionSnapshot,
    });
    await expect(
      resolveLockKey({ sessionId: 's1', snapshotId: 'snap' }, store, ctx),
    ).resolves.toBe('u1:s1');
    expect(getSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snap' }),
    );
  });

  test('ignores an empty snapshotId next to a sessionId', async () => {
    const { store, getSnapshot } = fakeStore({});
    await expect(
      resolveLockKey({ sessionId: 's1', snapshotId: '' }, store, ctx),
    ).resolves.toBe('u1:s1');
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  test('ignores an empty sessionId next to a snapshotId', async () => {
    const { store } = fakeStore({
      snap: { snapshotId: 'snap', sessionId: 's2' } as SessionSnapshot,
    });
    await expect(
      resolveLockKey({ sessionId: '', snapshotId: 'snap' }, store, ctx),
    ).resolves.toBe('u1:s2');
  });

  test('resolves snapshotId through the store with the context', async () => {
    const { store, getSnapshot } = fakeStore({
      snap: { snapshotId: 'snap', sessionId: 's2' } as SessionSnapshot,
    });
    await expect(
      resolveLockKey({ snapshotId: 'snap' }, store, ctx),
    ).resolves.toBe('u1:s2');
    expect(getSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snap', context: ctx }),
    );
  });

  test('returns undefined for an unknown snapshot', async () => {
    const { store } = fakeStore({});
    await expect(
      resolveLockKey({ snapshotId: 'nope' }, store, ctx),
    ).resolves.toBeUndefined();
  });

  test('returns undefined for a snapshot with no session', async () => {
    const { store } = fakeStore({
      snap: { snapshotId: 'snap' } as SessionSnapshot,
    });
    await expect(
      resolveLockKey({ snapshotId: 'snap' }, store, ctx),
    ).resolves.toBeUndefined();
  });

  test.each([
    [undefined],
    [null],
    [{}],
    ['x'],
    [{ sessionId: 5 }],
    [{ sessionId: '', snapshotId: '' }],
  ])('returns undefined for init %j', async (init) => {
    const { store } = fakeStore({});
    await expect(resolveLockKey(init, store, ctx)).resolves.toBeUndefined();
  });

  test('throws UNAUTHENTICATED without a uid', async () => {
    const { store } = fakeStore({});
    await expect(
      resolveLockKey({ sessionId: 's' }, store, {}),
    ).rejects.toMatchObject({
      status: 'UNAUTHENTICATED',
    });
  });
});

describe('sendError', () => {
  function fakeRes(headersSent = false) {
    const res = {
      headersSent,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
    };
    return { res, asResponse: res as unknown as Response };
  }

  test('maps GenkitError to its status and wire body', () => {
    const { res, asResponse } = fakeRes();
    const err = new GenkitError({ status: 'ABORTED', message: 'busy' });
    sendError(asResponse, err);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(err.toJSON());
  });

  test('hides unknown errors behind a logged 500', () => {
    const { res, asResponse } = fakeRes();
    const err = new Error('secret');
    sendError(asResponse, err);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: 'INTERNAL',
      message: 'Internal Error',
    });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), err);
  });

  test('only ends the response when headers were already sent', () => {
    const { res, asResponse } = fakeRes(true);
    sendError(asResponse, new Error('late'));
    expect(res.status).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });
});
