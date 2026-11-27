import { createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, test } from 'vitest';
import { client, defined, postRaw, signUp } from './helpers.js';

interface Ids {
  sessionId: string;
  snapshotId: string;
}

const userMessage = (text: string) => ({
  message: { role: 'user', content: [{ text }] },
});

describe('testAgent through the stock remoteAgent client', () => {
  test('rejects a request without a token with 401 UNAUTHENTICATED', async () => {
    const res = await postRaw('/', { data: userMessage('echo hi') });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain('UNAUTHENTICATED');
  });

  test('keeps history across turns and across a reload by sessionId', async () => {
    const { idToken } = await signUp();
    const chat = client(idToken).chat();

    const first = await chat.send('count');
    expect(first.text).toBe('user messages: 1');
    const second = await chat.send('count');
    expect(second.text).toBe('user messages: 2');
    const sessionId = defined(chat.sessionId, 'sessionId');

    const reloaded = await client(idToken).loadChat({ sessionId });
    const third = await reloaded.send('count');
    expect(third.text).toBe('user messages: 3');
  });

  test('pauses on an interrupt and resumes with a response', async () => {
    const { idToken } = await signUp();
    const chat = client(idToken).chat();

    const paused = await chat.send('please transfer money');
    expect(paused.finishReason).toBe('interrupted');
    const approval = defined(
      paused.interrupts.find((i) => i.name === 'approveTransfer'),
      'approveTransfer interrupt',
    );
    expect(approval.input).toEqual({ amount: 500 });

    const done = await chat.resume({
      respond: [approval.respond({ approved: true })],
    });
    expect(done.text).toContain('transfer result:');
    expect(done.text).toContain('"approved":true');
  });

  test('rejects detach with FAILED_PRECONDITION', async () => {
    const { idToken } = await signUp();

    const raw = await postRaw(
      '/',
      { data: { ...userMessage('echo hi'), detach: true } },
      idToken,
    );
    expect(raw.status).toBe(400);
    expect(JSON.stringify(raw.body)).toContain('FAILED_PRECONDITION');
  });

  test('serializes concurrent turns on one session with 409 ABORTED', async () => {
    const { idToken } = await signUp();
    const chat = client(idToken).chat();
    await chat.send('echo start');
    const sessionId = defined(chat.sessionId, 'sessionId');

    const [one, two] = await Promise.all([
      client(idToken).loadChat({ sessionId }),
      client(idToken).loadChat({ sessionId }),
    ]);
    const results = await Promise.allSettled([
      one.send('slow 4000'),
      two.send('slow 4000'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = String((rejected[0] as PromiseRejectedResult).reason);
    expect(reason).toMatch(/ABORTED|409/);

    const after = await client(idToken).loadChat({ sessionId });
    expect((await after.send('echo again')).text).toBe('again');
  });

  test.each([
    ['an empty snapshotId', (ids: Ids) => ({ ...ids, snapshotId: '' })],
    ['an empty sessionId', (ids: Ids) => ({ ...ids, sessionId: '' })],
  ])(
    'serializes concurrent raw turns that send %s with 409 ABORTED',
    async (_label, toInit) => {
      const { idToken } = await signUp();
      const chat = client(idToken).chat();
      const started = await chat.send('echo start');
      const init = toInit({
        sessionId: defined(chat.sessionId, 'sessionId'),
        snapshotId: defined(started.snapshotId, 'snapshotId'),
      });

      const responses = await Promise.all([
        postRaw('/', { data: userMessage('slow 4000'), init }, idToken),
        postRaw('/', { data: userMessage('slow 4000'), init }, idToken),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const accepted = defined(
        responses.find((r) => r.status === 200),
        '200 response',
      );
      expect(accepted.body.result).toMatchObject({
        finishReason: 'stop',
        message: { content: [{ text: 'slept' }] },
      });
      const rejected = defined(
        responses.find((r) => r.status === 409),
        '409 response',
      );
      expect(rejected.body).toEqual({
        status: 'ABORTED',
        message: 'Another turn is running for this session.',
      });
    },
  );

  test('does not contend across different sessions', async () => {
    const a = await signUp();
    const b = await signUp();
    const [resA, resB] = await Promise.all([
      client(a.idToken).chat().send('slow 1000'),
      client(b.idToken).chat().send('slow 1000'),
    ]);
    expect(resA.text).toBe('slept');
    expect(resB.text).toBe('slept');
  });
});

describe('cross-user isolation', () => {
  beforeAll(() => {
    initializeApp({ projectId: 'demo-test' });
  });

  async function startAliceSession() {
    const alice = await signUp();
    const chat = client(alice.idToken).chat();
    const first = await chat.send('count');
    expect(first.text).toBe('user messages: 1');
    const sessionId = defined(chat.sessionId, 'sessionId');
    const snapshotId = defined(first.snapshotId, 'snapshotId');
    const snapshot = await client(alice.idToken).getSnapshot(snapshotId);
    return { alice, sessionId, snapshotId, snapshot };
  }

  async function expectAliceUnchanged(
    alice: { idToken: string },
    ids: Ids,
    snapshot: unknown,
  ) {
    expect(await client(alice.idToken).getSnapshot(ids.snapshotId)).toEqual(
      snapshot,
    );
    const latest = await postRaw(
      '/getSnapshot',
      { data: { sessionId: ids.sessionId, metadataOnly: true } },
      alice.idToken,
    );
    expect(latest.status).toBe(200);
    expect(latest.body.result).toMatchObject({ snapshotId: ids.snapshotId });
    const resumed = await client(alice.idToken).loadChat({
      sessionId: ids.sessionId,
    });
    expect((await resumed.send('count')).text).toBe('user messages: 2');
  }

  test('stores snapshots, pointers and shards under the unscoped key of the uid', async () => {
    const { alice, sessionId, snapshotId } = await startAliceSession();
    const prefix = createHash('sha256')
      .update(JSON.stringify([null, alice.uid]))
      .digest('hex');
    const db = getFirestore();
    const snapshot = await db
      .doc(`agent-kit-sessions/${prefix}/snapshots/${snapshotId}`)
      .get();
    expect(snapshot.exists).toBe(true);
    const pointer = await db
      .doc(`agent-kit-sessions-pointers/${prefix}/pointers/${sessionId}`)
      .get();
    expect(pointer.exists).toBe(true);
    const shards = await db
      .collection(`agent-kit-sessions-shards/${prefix}/shards`)
      .limit(1)
      .get();
    expect(shards.size).toBe(1);
    const global = await db
      .doc(`agent-kit-sessions/global/snapshots/${snapshotId}`)
      .get();
    expect(global.exists).toBe(false);
  });

  test("starts a fresh session when user B sends user A's sessionId", async () => {
    const { alice, sessionId, snapshotId, snapshot } =
      await startAliceSession();
    const bob = await signUp();

    const res = await postRaw(
      '/',
      { data: userMessage('count'), init: { sessionId } },
      bob.idToken,
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      finishReason: 'stop',
      message: { role: 'model', content: [{ text: 'user messages: 1' }] },
      sessionId,
      snapshotId: expect.any(String),
    });
    expect(res.body.result).not.toMatchObject({ snapshotId });

    await expectAliceUnchanged(alice, { sessionId, snapshotId }, snapshot);
  });

  test("fails the turn when user B resumes user A's snapshotId", async () => {
    const { alice, sessionId, snapshotId, snapshot } =
      await startAliceSession();
    const bob = await signUp();

    const res = await postRaw(
      '/',
      { data: userMessage('count'), init: { snapshotId } },
      bob.idToken,
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      finishReason: 'failed',
      error: {
        status: 'NOT_FOUND',
        message: `Snapshot ${snapshotId} not found`,
      },
    });

    await expectAliceUnchanged(alice, { sessionId, snapshotId }, snapshot);
  });

  const internalError = {
    status: 500,
    body: { status: 'INTERNAL', message: 'Internal Error' },
  };

  test.each([
    ['/getSnapshot', 'snapshotId'],
    ['/getSnapshot', 'sessionId'],
    ['/waitForSnapshot', 'snapshotId'],
  ] as const)(
    "answers 500 INTERNAL (upstream maps NOT_FOUND to 500) when user B calls %s with user A's %s",
    async (path, idName) => {
      const { alice, sessionId, snapshotId, snapshot } =
        await startAliceSession();
      const bob = await signUp();
      const ids = { sessionId, snapshotId };

      const res = await postRaw(
        path,
        { data: { [idName]: ids[idName] } },
        bob.idToken,
      );
      expect(res).toEqual(internalError);

      await expectAliceUnchanged(alice, ids, snapshot);
    },
  );

  test("answers /abort with no status when user B sends user A's snapshotId", async () => {
    const { alice, sessionId, snapshotId, snapshot } =
      await startAliceSession();
    const bob = await signUp();

    const res = await postRaw('/abort', { data: { snapshotId } }, bob.idToken);
    expect(res).toEqual({ status: 200, body: { result: { snapshotId } } });

    await expectAliceUnchanged(alice, { sessionId, snapshotId }, snapshot);
  });

  test("rejects user B's client getSnapshot and resume with user A's snapshotId", async () => {
    const { alice, sessionId, snapshotId, snapshot } =
      await startAliceSession();
    const bob = await signUp();

    await expect(client(bob.idToken).getSnapshot(snapshotId)).rejects.toThrow(
      'Server returned: 500: {"message":"Internal Error","status":"INTERNAL"}',
    );
    await expect(
      client(bob.idToken).chat({ snapshotId }).send('count'),
    ).rejects.toMatchObject({
      name: 'AgentError',
      status: 'NOT_FOUND',
      message: `Snapshot ${snapshotId} not found`,
    });

    await expectAliceUnchanged(alice, { sessionId, snapshotId }, snapshot);
  });
});
