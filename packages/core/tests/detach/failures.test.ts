import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { genkit } from 'genkit/beta';
import { afterAll, describe, expect, test } from 'vitest';
import { defineDetachedTurns } from '../../src/detach.js';
import { createAgentApp } from '../../src/handler.js';
import { createUserScopedStore } from '../../src/store.js';
import { listenOnLoopback } from '../unit/listen.js';
import {
  admin,
  client,
  lockDoc,
  PROJECT,
  postDetach,
  runsOf,
  signUp,
  until,
} from './helpers.js';

/**
 * Serves the real turn route, Firestore run store and lock in this process,
 * with a queue that accepts runs and never delivers them.
 */
async function serveInProcess(uid: string) {
  admin();
  const ai = genkit({});
  const store = createUserScopedStore();
  const agent = ai.defineAgent({ name: 'inProcess', store });
  const app = createAgentApp(
    agent,
    { detach: defineDetachedTurns({ queue: 'never', store }) },
    {
      contextProvider: () => ({
        auth: {
          uid,
          rawToken: 'unused',
          token: {
            uid,
            sub: uid,
            aud: PROJECT,
            iss: `https://securetoken.google.com/${PROJECT}`,
            iat: 0,
            exp: 0,
            auth_time: 0,
            firebase: { identities: {}, sign_in_provider: 'password' },
          },
        },
      }),
      detach: { enqueue: async () => {} },
    },
  );
  const { server, base: url } = await listenOnLoopback(app);
  servers.push(server);
  const post = (sessionId: string, signal: AbortSignal) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          message: { role: 'user', content: [{ text: 'echo x' }] },
          detach: true,
        },
        init: { sessionId },
      }),
      signal,
    });
  return { post };
}

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(
    servers.map((s) => new Promise((r) => s.close(() => r(undefined)))),
  );
});

async function sessionOf(idToken: string) {
  const chat = client(idToken).chat();
  await chat.send('echo start');
  return { sessionId: chat.sessionId ?? '', snapshotId: chat.snapshotId };
}

describe('detached runs that do not start', () => {
  test('an enqueue failure cancels the run and releases the lock', async () => {
    const { uid, idToken } = await signUp();
    const { sessionId } = await sessionOf(idToken);
    const res = await postDetach(idToken, 'echo x', {
      name: 'brokenAgent',
      init: { sessionId },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'UNAVAILABLE' });
    const [run] = await runsOf(uid);
    expect(run).toMatchObject({ status: 'cancelled' });
    expect(run).not.toHaveProperty('input');
    expect((await lockDoc(uid, sessionId).get()).exists).toBe(false);
  });

  test('a client that goes away while the run is queued cancels it and releases the lock', async () => {
    // The Functions emulator does not pass a client disconnect on to the
    // function, so this serves the turn route in the test process.
    const { uid } = await signUp();
    const sessionId = randomUUID();
    const { post } = await serveInProcess(uid);
    const controller = new AbortController();
    const request = post(sessionId, controller.signal);
    await until('queued run', async () => (await runsOf(uid))[0], 10_000);
    controller.abort();
    await expect(request).rejects.toThrow();
    await until(
      'cancelled run',
      async () => (await runsOf(uid))[0]?.status === 'cancelled',
      10_000,
    );
    await until(
      'lock release',
      async () => !(await lockDoc(uid, sessionId).get()).exists,
      5_000,
    );
  });

  test('a run nobody claims in time is cancelled, its lock released, with 503', async () => {
    const { uid, idToken } = await signUp();
    const { sessionId } = await sessionOf(idToken);
    const res = await postDetach(idToken, 'echo x', {
      name: 'stalledAgent',
      init: { sessionId },
    });
    expect(res.status).toBe(503);
    expect((await runsOf(uid))[0]?.status).toBe('cancelled');
    expect((await lockDoc(uid, sessionId).get()).exists).toBe(false);
    const next = await client(idToken).loadChat({ sessionId });
    expect((await next.send('echo free')).text).toBe('free');
  });

  test('a claimed run without output in time is abandoned: 503, and the worker aborts the turn', async () => {
    const { uid, idToken } = await signUp();
    const { sessionId } = await sessionOf(idToken);
    await admin().auth.setCustomUserClaims(uid, { stallDetach: true });
    const res = await postDetach(idToken, 'echo x', { init: { sessionId } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'UNAVAILABLE' });
    const settled = await until(
      'abandoned run settled',
      async () => {
        const [run] = await runsOf(uid);
        return run?.status === 'cancelled' && run;
      },
      60_000,
      500,
    );
    expect(settled).toMatchObject({ final: { status: 'aborted' } });
    await until(
      'lock release',
      async () => !(await lockDoc(uid, sessionId).get()).exists,
      5_000,
    );
    const tip = await client(idToken).getSnapshot({ sessionId });
    expect(tip?.status).toBe('aborted');
  }, 120_000);
});
