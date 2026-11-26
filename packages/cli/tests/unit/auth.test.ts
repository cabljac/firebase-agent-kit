import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  AUTH_NETWORK_ERROR,
  AuthError,
  authScope,
  decodeIdToken,
  REFRESH_MARGIN_MS,
  RefreshingTokenSource,
  StaticTokenSource,
  signIn,
  UsageError,
} from '../../src/auth.js';
import { ConfigStore } from '../../src/store.js';

const jwt = (claims: object) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

interface Call {
  url: string;
  body: string;
}

/** A fake fetch that answers each call with the next queued response. */
function fakeFetch(...responses: { status?: number; json: unknown }[]) {
  const calls: Call[] = [];
  const impl = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return new Response(JSON.stringify(next.json), {
      status: next.status ?? 200,
    });
  });
  return { fetch: impl, calls };
}

const refreshGrant = (n: number, refreshToken = 'refresh-1') => ({
  json: {
    id_token: `id-${n}`,
    refresh_token: refreshToken,
    expires_in: '3600',
    user_id: 'uid-1',
  },
});

let dir: string;
let store: ConfigStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fak-auth-'));
  store = new ConfigStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('reuses the ID token until it is within the refresh margin', async () => {
  let now = 1_000_000;
  const { fetch, calls } = fakeFetch(refreshGrant(1), refreshGrant(2));
  const source = new RefreshingTokenSource({
    apiKey: 'key',
    user: { uid: 'uid-1' },
    refreshToken: 'refresh-1',
    fetch,
    now: () => now,
  });

  expect(await source.getIdToken()).toBe('id-1');
  now += 3600_000 - REFRESH_MARGIN_MS - 1;
  expect(await source.getIdToken()).toBe('id-1');
  expect(calls).toHaveLength(1);

  now += 1;
  expect(await source.getIdToken()).toBe('id-2');
  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toBe(
    'https://securetoken.googleapis.com/v1/token?key=key',
  );
  expect(calls[0]?.body).toBe(
    'grant_type=refresh_token&refresh_token=refresh-1',
  );
});

test('shares one refresh between concurrent callers', async () => {
  const { fetch, calls } = fakeFetch(refreshGrant(1));
  const source = new RefreshingTokenSource({
    apiKey: 'key',
    user: { uid: 'uid-1' },
    refreshToken: 'refresh-1',
    fetch,
  });
  const tokens = await Promise.all([source.getIdToken(), source.getIdToken()]);
  expect(tokens).toEqual(['id-1', 'id-1']);
  expect(calls).toHaveLength(1);
});

test('reports a rotated refresh token', async () => {
  const onRefreshToken = vi.fn();
  const { fetch } = fakeFetch(refreshGrant(1, 'refresh-2'));
  const source = new RefreshingTokenSource({
    apiKey: 'key',
    user: { uid: 'uid-1' },
    refreshToken: 'refresh-1',
    fetch,
    onRefreshToken,
  });
  await source.getIdToken();
  expect(onRefreshToken).toHaveBeenCalledWith('refresh-2');
});

test('uses the Auth emulator when FIREBASE_AUTH_EMULATOR_HOST is set', async () => {
  const { fetch, calls } = fakeFetch(refreshGrant(1));
  const source = new RefreshingTokenSource({
    apiKey: 'key',
    user: { uid: 'uid-1' },
    refreshToken: 'refresh-1',
    fetch,
    env: { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' },
  });
  await source.getIdToken();
  expect(calls[0]?.url).toBe(
    'http://127.0.0.1:9099/securetoken.googleapis.com/v1/token?key=key',
  );
});

test('signs in with the password, then reuses the saved refresh token', async () => {
  const promptPassword = vi.fn(async () => 'pw');
  const first = fakeFetch({
    json: {
      idToken: 'id-0',
      refreshToken: 'refresh-1',
      expiresIn: '3600',
      localId: 'uid-1',
    },
  });
  const source = await signIn({
    apiKey: 'key',
    email: 'a@example.com',
    store,
    promptPassword,
    fetch: first.fetch,
  });
  expect(await source.getIdToken()).toBe('id-0');
  expect(source.user).toEqual({ uid: 'uid-1', email: 'a@example.com' });
  expect(JSON.parse(first.calls[0]?.body ?? '')).toEqual({
    email: 'a@example.com',
    password: 'pw',
    returnSecureToken: true,
  });

  const second = fakeFetch(refreshGrant(1));
  const again = await signIn({
    apiKey: 'key',
    store,
    promptPassword,
    fetch: second.fetch,
  });
  expect(promptPassword).toHaveBeenCalledTimes(1);
  expect(await again.getIdToken()).toBe('id-1');
  expect(again.user.email).toBe('a@example.com');
});

test('deletes a dead refresh token and asks for the password again', async () => {
  await store.saveCredential('key', {
    email: 'a@example.com',
    uid: 'uid-1',
    refreshToken: 'dead',
  });
  const promptPassword = vi.fn(async () => 'pw');
  const { fetch } = fakeFetch(
    { status: 400, json: { error: { message: 'TOKEN_EXPIRED' } } },
    {
      json: {
        idToken: 'id-0',
        refreshToken: 'refresh-2',
        expiresIn: '3600',
        localId: 'uid-1',
      },
    },
  );
  await signIn({ apiKey: 'key', store, promptPassword, fetch });
  expect(promptPassword).toHaveBeenCalledWith('a@example.com');
  expect((await store.getCredential('key'))?.refreshToken).toBe('refresh-2');
});

test('reports a network failure as an Auth network error and keeps the saved token', async () => {
  await store.saveCredential('key', {
    email: 'a@example.com',
    uid: 'uid-1',
    refreshToken: 'good',
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new TypeError('fetch failed');
  });
  const err = await signIn({
    apiKey: 'key',
    store,
    promptPassword: vi.fn(),
    fetch,
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AuthError);
  expect(err).toMatchObject({ code: AUTH_NETWORK_ERROR });
  expect((await store.getCredential('key'))?.refreshToken).toBe('good');
});

test('keeps emulator and production sign-ins apart', async () => {
  const promptPassword = vi.fn(async () => 'pw');
  const grant = {
    json: {
      idToken: 'id-0',
      refreshToken: 'emu-refresh',
      expiresIn: '3600',
      localId: 'uid-1',
    },
  };
  await signIn({
    apiKey: 'key',
    email: 'a@example.com',
    store,
    promptPassword,
    env: { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' },
    fetch: fakeFetch(grant).fetch,
  });
  expect(await store.getCredential('key')).toBeUndefined();
  expect(
    await store.getCredential(
      authScope('key', { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }),
    ),
  ).toMatchObject({ refreshToken: 'emu-refresh' });
});

test('an expired ID token fails with ID_TOKEN_EXPIRED, now and later', async () => {
  let now = 1_000_000;
  const token = jwt({ user_id: 'u', exp: 2000 });
  expect(() => new StaticTokenSource(token, () => 2_000_000)).toThrow(
    'expired',
  );
  const source = new StaticTokenSource(token, () => now);
  expect(await source.getIdToken()).toBe(token);
  now = 2_000_000;
  await expect(source.getIdToken()).rejects.toMatchObject({
    code: 'ID_TOKEN_EXPIRED',
  });
});

test('reports a wrong password with the Firebase error code', async () => {
  const { fetch } = fakeFetch({
    status: 400,
    json: { error: { message: 'INVALID_LOGIN_CREDENTIALS' } },
  });
  const err = await signIn({
    apiKey: 'key',
    email: 'a@example.com',
    store,
    promptPassword: async () => 'wrong',
    fetch,
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AuthError);
  expect(err).toMatchObject({ code: 'INVALID_LOGIN_CREDENTIALS' });
  expect(await store.getCredential('key')).toBeUndefined();
});

test('splits a Firebase error message into code and detail', async () => {
  const { fetch } = fakeFetch({
    status: 400,
    json: {
      error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER : Try again later.' },
    },
  });
  const err = await signIn({
    apiKey: 'key',
    email: 'a@example.com',
    store,
    promptPassword: async () => 'pw',
    fetch,
  }).catch((e: unknown) => e);
  expect(err).toMatchObject({
    code: 'TOO_MANY_ATTEMPTS_TRY_LATER',
    message: 'Try again later.',
  });
});

test('asks for --api-key or --email when it cannot sign in', async () => {
  await expect(
    signIn({ store, promptPassword: vi.fn() }),
  ).rejects.toBeInstanceOf(UsageError);
  await expect(
    signIn({ apiKey: 'key', store, promptPassword: vi.fn() }),
  ).rejects.toThrow('Pass --email');
});

test('uses a given ID token as is, without signing in', async () => {
  const token = jwt({ user_id: 'uid-9', email: 'z@example.com', exp: 9e9 });
  const source = await signIn({
    idToken: token,
    store,
    promptPassword: vi.fn(),
  });
  expect(source).toBeInstanceOf(StaticTokenSource);
  expect(source.user).toEqual({ uid: 'uid-9', email: 'z@example.com' });
  expect(await source.getIdToken()).toBe(token);
});

test('decodeIdToken rejects a token without a user id', () => {
  expect(() => decodeIdToken(jwt({ email: 'x' }))).toThrow(AuthError);
  expect(() => decodeIdToken('nope')).toThrow(AuthError);
  expect(decodeIdToken(jwt({ sub: 'u', exp: 5 }))).toEqual({
    uid: 'u',
    email: undefined,
    exp: 5,
  });
});
