import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { DETACH_LEASE_MS } from '../../src/detach.js';
import { lockKey } from '../../src/keys.js';
import { FirestoreTurnLock } from '../../src/lock.js';
import { FirestoreRunStore } from '../../src/runs.js';
import {
  admin,
  BASE,
  client,
  lockDoc,
  runsOf,
  signUp,
  snapshotCount,
  until,
} from './helpers.js';

const runs = () => new FirestoreRunStore(() => admin().db, 'agent-kit-runs');

/** Writes a queued run and takes its lock, the way the turn route does. */
async function queuedRun(uid: string, idToken: string, sessionId: string) {
  const runId = randomUUID();
  const claims = await admin().auth.verifyIdToken(idToken);
  const key = lockKey(uid, sessionId);
  const lease = await new FirestoreTurnLock().acquire(key, {
    leaseMs: DETACH_LEASE_MS,
    owner: runId,
  });
  expect(lease).not.toBeNull();
  await runs().create(
    runId,
    {
      uid,
      instanceId: null,
      lockKey: key,
      input: { message: { role: 'user', content: [{ text: 'echo direct' }] } },
      init: { sessionId },
      claims,
    },
    Date.now(),
  );
  return runId;
}

const deliver = (runId: string) =>
  fetch(`${BASE}/detachWorker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { runId } }),
  }).then((r) => r.status);

async function sessionOf(idToken: string) {
  const chat = client(idToken).chat();
  await chat.send('echo start');
  return chat.sessionId ?? '';
}

describe('worker deliveries', () => {
  test('a redelivery of a finished run is refused', async () => {
    const { uid, idToken } = await signUp();
    const chat = client(idToken).chat();
    await chat.send('echo start');
    const task = await chat.detach('echo once');
    await task.wait();
    const [run] = await runsOf(uid);
    const before = await snapshotCount(uid);
    expect(await deliver(run?.id ?? '')).toBe(204);
    expect(await snapshotCount(uid)).toBe(before);
    expect((await runsOf(uid))[0]?.status).toBe(run?.status);
  });

  test('two concurrent deliveries of one run run the turn once', async () => {
    const { uid, idToken } = await signUp();
    const sessionId = await sessionOf(idToken);
    const runId = await queuedRun(uid, idToken, sessionId);
    const before = await snapshotCount(uid);
    await Promise.all([deliver(runId), deliver(runId)]);
    const settled = await until(
      'run settled',
      async () => {
        const run = (await runsOf(uid)).find((r) => r.id === runId);
        return run?.status === 'done' && run;
      },
      20_000,
    );
    expect(settled).toMatchObject({ final: { status: 'completed' } });
    expect(await snapshotCount(uid)).toBe(before + 1);
  });

  test('a run claimed for a user who was disabled after enqueue is cancelled and not run', async () => {
    const { uid, idToken } = await signUp();
    const sessionId = await sessionOf(idToken);
    const runId = await queuedRun(uid, idToken, sessionId);
    await admin().auth.updateUser(uid, { disabled: true });
    const before = await snapshotCount(uid);
    expect(await deliver(runId)).toBe(204);
    const [run] = await runsOf(uid);
    expect(run).toMatchObject({
      status: 'cancelled',
      error: { status: 'PERMISSION_DENIED' },
    });
    expect(await snapshotCount(uid)).toBe(before);
    expect((await lockDoc(uid, sessionId).get()).exists).toBe(false);
  });

  test('a run claimed after the user revoked their tokens is cancelled and not run', async () => {
    const { uid, idToken } = await signUp();
    const sessionId = await sessionOf(idToken);
    const runId = await queuedRun(uid, idToken, sessionId);
    await new Promise((r) => setTimeout(r, 1_100));
    await admin().auth.revokeRefreshTokens(uid);
    const before = await snapshotCount(uid);
    expect(await deliver(runId)).toBe(204);
    expect((await runsOf(uid))[0]).toMatchObject({
      status: 'cancelled',
      error: { status: 'UNAUTHENTICATED' },
    });
    expect(await snapshotCount(uid)).toBe(before);
    expect((await lockDoc(uid, sessionId).get()).exists).toBe(false);
  });

  test('a run whose lock another holder took is cancelled and not run', async () => {
    const { uid, idToken } = await signUp();
    const sessionId = await sessionOf(idToken);
    const runId = await queuedRun(uid, idToken, sessionId);
    await lockDoc(uid, sessionId).set({
      owner: 'someone-else',
      expiresAt: Date.now() + 60_000,
    });
    const before = await snapshotCount(uid);
    expect(await deliver(runId)).toBe(204);
    expect((await runsOf(uid))[0]).toMatchObject({
      status: 'cancelled',
      error: { status: 'ABORTED' },
    });
    expect(await snapshotCount(uid)).toBe(before);
    expect((await lockDoc(uid, sessionId).get()).data()?.owner).toBe(
      'someone-else',
    );
  });
});

describe('FirestoreRunStore', () => {
  test('claim scrubs the input, init and claims in the same write', async () => {
    const { uid, idToken } = await signUp();
    const runId = await queuedRun(uid, idToken, randomUUID());
    const claimed = await runs().claim(runId, null, Date.now());
    expect(claimed).toMatchObject({
      uid,
      init: { sessionId: expect.any(String) },
    });
    const doc = (
      await admin().db.collection('agent-kit-runs').doc(runId).get()
    ).data();
    expect(doc).toMatchObject({ status: 'running', uid });
    expect(doc).not.toHaveProperty('input');
    expect(doc).not.toHaveProperty('init');
    expect(doc).not.toHaveProperty('claims');
  });

  test('concurrent claims hand the run to exactly one caller', async () => {
    const { uid, idToken } = await signUp();
    const runId = await queuedRun(uid, idToken, randomUUID());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => runs().claim(runId, null, Date.now())),
    );
    expect(results.filter((r) => typeof r !== 'string')).toHaveLength(1);
    expect(results.filter((r) => r === 'not-queued')).toHaveLength(4);
  });

  test('a run of another instance is refused', async () => {
    const { uid, idToken } = await signUp();
    const runId = await queuedRun(uid, idToken, randomUUID());
    expect(await runs().claim(runId, 'other', Date.now())).toBe(
      'wrong-instance',
    );
  });
});
