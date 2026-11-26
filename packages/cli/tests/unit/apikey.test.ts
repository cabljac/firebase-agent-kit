import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  adcPath,
  googleAccess,
  ManagementApiError,
  NoGoogleCredentialsError,
  projectApiKey,
} from '../../src/apikey.js';

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-chat-adc-'));
  env = { GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'adc.json') };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const userAdc = () =>
  writeFile(
    join(dir, 'adc.json'),
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'cid',
      client_secret: 'secret',
      refresh_token: 'rt',
    }),
  );

interface Call {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fake Google HTTP layer: token endpoint plus Management API routes. */
function google(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)]),
    );
    calls.push({
      url,
      headers,
      body: init?.body ? String(init.body) : undefined,
    });
    const route = Object.keys(routes).find((r) => url.startsWith(r));
    const res = route ? routes[route] : { status: 404, json: {} };
    return new Response(JSON.stringify(res?.json), {
      status: res?.status ?? 200,
    });
  });
  return { fetch, calls };
}

const TOKEN = 'https://oauth2.googleapis.com/token';
const APPS = 'https://firebase.googleapis.com/v1beta1/projects/p/webApps';

test('returns the shared key of all web apps without asking', async () => {
  await userAdc();
  const { fetch, calls } = google({
    [TOKEN]: { json: { access_token: 'at' } },
    [`${APPS}/a1/config`]: { json: { apiKey: 'shared' } },
    [`${APPS}/a2/config`]: { json: { apiKey: 'shared' } },
    [APPS]: {
      json: {
        apps: [
          { appId: 'a1', displayName: 'Web', state: 'ACTIVE' },
          { appId: 'a2', displayName: 'Admin', state: 'ACTIVE' },
          { appId: 'gone', state: 'DELETED' },
        ],
      },
    },
  });
  const pickApp = vi.fn();
  expect(await projectApiKey({ project: 'p', env, fetch, pickApp })).toBe(
    'shared',
  );
  expect(pickApp).not.toHaveBeenCalled();
  expect(calls[0]?.body).toBe(
    'grant_type=refresh_token&client_id=cid&client_secret=secret&refresh_token=rt',
  );
  const api = calls.filter((c) => c.url.startsWith(APPS));
  expect(api).toHaveLength(3);
  for (const call of api) {
    expect(call.headers).toMatchObject({
      Authorization: 'Bearer at',
      'x-goog-user-project': 'p',
    });
  }
});

test('asks which app when the keys differ, and fails without a picker', async () => {
  await userAdc();
  const routes = {
    [TOKEN]: { json: { access_token: 'at' } },
    [`${APPS}/a1/config`]: { json: { apiKey: 'k1' } },
    [`${APPS}/a2/config`]: { json: { apiKey: 'k2' } },
    [APPS]: {
      json: { apps: [{ appId: 'a1' }, { appId: 'a2', displayName: 'Two' }] },
    },
  };
  const pickApp = vi.fn(async (apps: { apiKey: string }[]) => {
    const second = apps[1];
    if (!second) throw new Error('no app');
    return { ...second, appId: 'a2', displayName: 'Two' };
  });
  expect(
    await projectApiKey({
      project: 'p',
      env,
      fetch: google(routes).fetch,
      pickApp,
    }),
  ).toBe('k2');
  await expect(
    projectApiKey({ project: 'p', env, fetch: google(routes).fetch }),
  ).rejects.toMatchObject({ title: 'Several web apps' });
});

test('fails clearly when the project has no web app', async () => {
  await userAdc();
  const { fetch } = google({
    [TOKEN]: { json: { access_token: 'at' } },
    [APPS]: { json: {} },
  });
  await expect(
    projectApiKey({ project: 'p', env, fetch }),
  ).rejects.toMatchObject({ title: 'No web app' });
});

test('reports a Management API error with its status', async () => {
  await userAdc();
  const { fetch } = google({
    [TOKEN]: { json: { access_token: 'at' } },
    [APPS]: { status: 403, json: { error: { message: 'Permission denied' } } },
  });
  const err = await projectApiKey({ project: 'p', env, fetch }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ManagementApiError);
  expect(err).toMatchObject({ status: 403, message: 'Permission denied' });
});

test('without credentials it throws NoGoogleCredentialsError', async () => {
  await expect(googleAccess({ env })).rejects.toBeInstanceOf(
    NoGoogleCredentialsError,
  );
  const { fetch } = google({
    [TOKEN]: { status: 400, json: { error: 'invalid_grant' } },
  });
  await userAdc();
  await expect(googleAccess({ env, fetch })).rejects.toThrow('invalid_grant');
});

test('signs a JWT for a service account key', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  await writeFile(
    join(dir, 'adc.json'),
    JSON.stringify({
      type: 'service_account',
      client_email: 'sa@p.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  );
  const { fetch, calls } = google({
    [TOKEN]: { json: { access_token: 'sa' } },
  });
  expect(await googleAccess({ env, fetch })).toEqual({
    token: 'sa',
    user: false,
  });
  const assertion = new URLSearchParams(calls[0]?.body).get('assertion') ?? '';
  const [header = '', payload = '', signature = ''] = assertion.split('.');
  expect(
    createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url')),
  ).toBe(true);
  expect(
    JSON.parse(Buffer.from(payload, 'base64url').toString()),
  ).toMatchObject({ iss: 'sa@p.iam.gserviceaccount.com', aud: TOKEN });
});

test('adcPath follows GOOGLE_APPLICATION_CREDENTIALS, then CLOUDSDK_CONFIG', () => {
  expect(adcPath({ GOOGLE_APPLICATION_CREDENTIALS: '/a.json' }, '/h')).toBe(
    '/a.json',
  );
  expect(adcPath({ CLOUDSDK_CONFIG: '/g' }, '/h')).toBe(
    '/g/application_default_credentials.json',
  );
});
