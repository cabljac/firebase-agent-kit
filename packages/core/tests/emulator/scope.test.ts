import { createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { remoteAgent } from 'genkit/beta/client';
import { beforeAll, expect, test } from 'vitest';
import { defined, signUp } from './helpers.js';

const url = (scope: string) =>
  `http://127.0.0.1:5001/demo-test/us-central1/${scope}Agent`;

const client = (scope: string, idToken: string) =>
  remoteAgent({
    url: url(scope),
    headers: { Authorization: `Bearer ${idToken}` },
  });

async function post(
  scope: string,
  path: string,
  body: unknown,
  idToken: string,
) {
  const res = await fetch(`${url(scope)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-test' }, 'scope'));
});

async function startAlphaSession() {
  const user = await signUp();
  const chat = client('alpha', user.idToken).chat();
  const first = await chat.send('count');
  expect(first.text).toBe('user messages: 1');
  return {
    user,
    sessionId: defined(chat.sessionId, 'sessionId'),
    snapshotId: defined(first.snapshotId, 'snapshotId'),
  };
}

async function expectAlphaResumes(idToken: string, sessionId: string) {
  const resumed = await client('alpha', idToken).loadChat({ sessionId });
  expect((await resumed.send('count')).text).toBe('user messages: 2');
}

test('a scoped store keeps snapshots under the key of the scope and uid', async () => {
  const { user, snapshotId } = await startAlphaSession();
  const prefix = createHash('sha256')
    .update(JSON.stringify(['alpha', user.uid]))
    .digest('hex');
  const snapshot = await db
    .doc(`agent-kit-sessions/${prefix}/snapshots/${snapshotId}`)
    .get();
  expect(snapshot.exists).toBe(true);
});

test("an agent with another scope cannot resume or read the same user's snapshot", async () => {
  const { user, sessionId, snapshotId } = await startAlphaSession();
  await expect(
    client('beta', user.idToken).chat({ snapshotId }).send('count'),
  ).rejects.toMatchObject({
    name: 'AgentError',
    status: 'NOT_FOUND',
    message: `Snapshot ${snapshotId} not found`,
  });
  expect(
    await post('beta', '/getSnapshot', { data: { snapshotId } }, user.idToken),
  ).toEqual({
    status: 500,
    body: { status: 'INTERNAL', message: 'Internal Error' },
  });
  await expectAlphaResumes(user.idToken, sessionId);
});
