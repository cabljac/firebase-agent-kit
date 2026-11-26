import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { AuthError, signIn, type TokenSource } from '../../src/auth.js';
import { ChatCore } from '../../src/chat.js';
import { explain } from '../../src/errors.js';
import { ConfigStore } from '../../src/store.js';

const URL = 'http://127.0.0.1:5001/demo-test/us-central1/testAgent';
const AUTH_HOST = '127.0.0.1:9099';
const API_KEY = 'fake-api-key';
const env = { FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST };

let dir: string;
let store: ConfigStore;
let tokens: TokenSource;
const email = `cli-${Date.now()}@example.com`;
const password = 'cli-password-123';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fak-emulator-'));
  store = new ConfigStore(dir);
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!res.ok) throw new Error(`signUp failed: ${res.status}`);
  tokens = await signIn({
    apiKey: API_KEY,
    email,
    store,
    env,
    promptPassword: async () => password,
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const core = () => new ChatCore({ url: URL, tokens, store });
const FIRESTORE =
  'http://127.0.0.1:8080/v1/projects/demo-test/databases/(default)/documents';

/** Polls `check` until it resolves true. */
async function until(check: () => Promise<boolean>, what: string) {
  const end = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** True while the turn lock of `sessionId` exists in the Firestore emulator. */
async function lockHeld(sessionId: string): Promise<boolean> {
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
  const userKey = sha256(JSON.stringify([null, tokens.user.uid]));
  const id = sha256(`${userKey}:${sessionId}`);
  const res = await fetch(`${FIRESTORE}/agent-kit-locks/${id}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  return res.status === 200;
}
const firstOf = <T>(list: T[]): T => {
  const [item] = list;
  if (item === undefined) throw new Error('Expected a non-empty list');
  return item;
};

test('signs in again from the saved refresh token, without a password', async () => {
  const promptPassword = vi.fn(async () => password);
  const again = await signIn({ apiKey: API_KEY, store, env, promptPassword });
  expect(promptPassword).not.toHaveBeenCalled();
  expect(again.user).toEqual(tokens.user);
  expect(await again.getIdToken()).toMatch(/\./);
});

test('rejects a wrong password with a sign-in problem', async () => {
  const err = await signIn({
    apiKey: API_KEY,
    email: `missing-${Date.now()}@example.com`,
    store,
    env,
    promptPassword: async () => 'wrong',
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AuthError);
  expect(explain(err).kind).toBe('sign-in');
});

test('runs a turn, streams it, and records the session', async () => {
  const chat = core();
  const onText = vi.fn();
  const outcome = await chat.runTurn(
    { message: 'stream one two three' },
    { onText },
  );
  expect(outcome).toEqual({ status: 'done', text: 'one two three', tools: [] });
  expect(onText.mock.calls).toEqual([['one'], ['one two'], ['one two three']]);
  expect(chat.sessionId).toBeDefined();
  expect(await store.getLastSession(URL, tokens.user.uid)).toBe(chat.sessionId);
});

test('stops on an interrupt and resumes with the approval', async () => {
  const chat = core();
  const paused = await chat.runTurn({ message: 'please transfer' });
  expect(paused.status).toBe('interrupted');
  if (paused.status !== 'interrupted') return;
  expect(paused.interrupts).toEqual([
    { name: 'approveTransfer', ref: 'transfer-1', input: { amount: 500 } },
  ]);

  const done = await chat.runTurn({
    respond: [
      { interrupt: firstOf(paused.interrupts), output: { approved: true } },
    ],
  });
  expect(done).toMatchObject({
    status: 'done',
    text: 'transfer result: {"approved":true}',
  });
});

test('resumes a session by id, with history and a pending interrupt', async () => {
  const first = core();
  await first.runTurn({ message: 'echo one' });
  await first.runTurn({ message: 'transfer' });
  const sessionId = first.sessionId;
  if (!sessionId) throw new Error('no session id');

  const second = core();
  const { history, pending } = await second.loadSession(sessionId);
  expect(second.sessionId).toBe(sessionId);
  expect(history).toEqual([
    { role: 'user', text: 'echo one' },
    { role: 'agent', text: 'one', tools: [] },
    { role: 'user', text: 'transfer' },
  ]);
  expect(pending).toEqual([
    { name: 'approveTransfer', ref: 'transfer-1', input: { amount: 500 } },
  ]);

  const answered = await second.runTurn({
    respond: [{ interrupt: firstOf(pending), output: { approved: false } }],
  });
  expect(answered.text).toBe('transfer result: {"approved":false}');
  expect(await second.runTurn({ message: 'count' })).toMatchObject({
    text: 'user messages: 3',
  });
});

test('explains an unknown session id', async () => {
  const err = await core()
    .loadSession('no-such-session')
    .catch((e: unknown) => e);
  expect(explain(err).kind).toBe('session-not-found');
});

test('reports 409 while another turn runs, then succeeds after a reload', async () => {
  const owner = core();
  await owner.runTurn({ message: 'echo start' });
  const sessionId = owner.sessionId;
  if (!sessionId) throw new Error('no session id');

  const other = core();
  await other.loadSession(sessionId);
  const slow = owner.runTurn({ message: 'slow 8000' });
  await until(() => lockHeld(sessionId), 'the turn lock');

  const err = await other
    .runTurn({ message: 'echo second' })
    .catch((e: unknown) => e);
  expect(explain(err).kind).toBe('busy');

  await slow;
  await until(async () => !(await lockHeld(sessionId)), 'the lock release');
  await other.reload();
  expect(await other.runTurn({ message: 'count' })).toMatchObject({
    status: 'done',
    text: 'user messages: 3',
  });
});

test('a local abort ends the turn, and the next turn reloads the session', async () => {
  const chat = core();
  await chat.runTurn({ message: 'echo start' });
  const sessionId = chat.sessionId;
  if (!sessionId) throw new Error('no session id');
  const controller = new AbortController();
  const turn = chat.runTurn(
    { message: 'slow 2000' },
    { signal: controller.signal },
  );
  await until(() => lockHeld(sessionId), 'the turn lock');
  controller.abort();
  expect(await turn).toMatchObject({ status: 'aborted' });

  await until(async () => {
    const { history } = await core().loadSession(sessionId);
    return history.at(-1)?.text === 'slept';
  }, 'the server to finish the stopped turn');
  expect(await chat.runTurn({ message: 'count' })).toMatchObject({
    status: 'done',
    text: 'user messages: 3',
  });
});
