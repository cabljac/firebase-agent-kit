import type { Response } from 'express';
import { GenkitError } from 'genkit';
import type { ActionContext, Agent, SessionSnapshot } from 'genkit/beta';
import { describe, expect, test, vi } from 'vitest';
import { lockKey } from '../../src/keys.js';

vi.mock('firebase-functions', () => ({ logger: { error: vi.fn() } }));

import { logger } from 'firebase-functions';
import {
  assertNotDetach,
  isAuthedContext,
  isRequestContext,
  requireUid,
  resolveLockKey,
  sendError,
} from '../../src/guards.js';

function fakeAgent(snapshots: Record<string, SessionSnapshot>) {
  const getSnapshotData = vi.fn(
    async (
      opts: Parameters<Agent['getSnapshotData']>[0],
    ): Promise<SessionSnapshot | undefined> =>
      opts.snapshotId ? snapshots[opts.snapshotId] : undefined,
  );
  const agent: Pick<Agent, 'getSnapshotData'> = {
    getSnapshotData,
  };
  return { agent, getSnapshotData };
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

describe('isAuthedContext', () => {
  test('accepts Firebase Auth data with a uid', () => {
    expect(
      isAuthedContext({ auth: { uid: 'u1', token: {}, rawToken: 't' } }),
    ).toBe(true);
  });

  test.each([
    [{}],
    [{ auth: { uid: 'u1' } }],
    [{ auth: { uid: '', token: {}, rawToken: 't' } }],
    [{ auth: { uid: 'u1', rawToken: 't' } }],
  ])('rejects %j', (c) => {
    expect(isAuthedContext(c)).toBe(false);
  });

  test('accepts a worker context without a raw token', () => {
    expect(isAuthedContext({ auth: { uid: 'u1', token: {} } })).toBe(true);
  });
});

describe('isRequestContext', () => {
  test('requires the raw ID token', () => {
    expect(
      isRequestContext({ auth: { uid: 'u1', token: {}, rawToken: 't' } }),
    ).toBe(true);
    expect(isRequestContext({ auth: { uid: 'u1', token: {} } })).toBe(false);
  });
});

describe('resolveLockKey', () => {
  test('uses sessionId directly without reading a snapshot', async () => {
    const { agent, getSnapshotData } = fakeAgent({});
    await expect(resolveLockKey({ sessionId: 's1' }, agent, ctx)).resolves.toBe(
      lockKey('u1', 's1'),
    );
    expect(getSnapshotData).not.toHaveBeenCalled();
  });

  test('resolves snapshotId first when both ids are present', async () => {
    const { agent, getSnapshotData } = fakeAgent({
      snap: { snapshotId: 'snap', sessionId: 's1' } as SessionSnapshot,
    });
    await expect(
      resolveLockKey({ sessionId: 's1', snapshotId: 'snap' }, agent, ctx),
    ).resolves.toBe(lockKey('u1', 's1'));
    expect(getSnapshotData).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snap' }),
    );
  });

  test('ignores an empty snapshotId next to a sessionId', async () => {
    const { agent, getSnapshotData } = fakeAgent({});
    await expect(
      resolveLockKey({ sessionId: 's1', snapshotId: '' }, agent, ctx),
    ).resolves.toBe(lockKey('u1', 's1'));
    expect(getSnapshotData).not.toHaveBeenCalled();
  });

  test('ignores an empty sessionId next to a snapshotId', async () => {
    const { agent } = fakeAgent({
      snap: { snapshotId: 'snap', sessionId: 's2' } as SessionSnapshot,
    });
    await expect(
      resolveLockKey({ sessionId: '', snapshotId: 'snap' }, agent, ctx),
    ).resolves.toBe(lockKey('u1', 's2'));
  });

  test("reads snapshotId metadata through the agent's store with the context", async () => {
    const { agent, getSnapshotData } = fakeAgent({
      snap: { snapshotId: 'snap', sessionId: 's2' } as SessionSnapshot,
    });
    await expect(
      resolveLockKey({ snapshotId: 'snap' }, agent, ctx),
    ).resolves.toBe(lockKey('u1', 's2'));
    expect(getSnapshotData).toHaveBeenCalledWith({
      snapshotId: 'snap',
      metadataOnly: true,
      context: ctx,
    });
  });

  test('returns undefined for an unknown snapshot', async () => {
    const { agent } = fakeAgent({});
    await expect(
      resolveLockKey({ snapshotId: 'nope' }, agent, ctx),
    ).resolves.toBeUndefined();
  });

  test('returns undefined for a snapshot with no session', async () => {
    const { agent } = fakeAgent({
      snap: { snapshotId: 'snap' } as SessionSnapshot,
    });
    await expect(
      resolveLockKey({ snapshotId: 'snap' }, agent, ctx),
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
    const { agent } = fakeAgent({});
    await expect(resolveLockKey(init, agent, ctx)).resolves.toBeUndefined();
  });

  test('throws UNAUTHENTICATED without a uid', async () => {
    const { agent } = fakeAgent({});
    await expect(
      resolveLockKey({ sessionId: 's' }, agent, {}),
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
