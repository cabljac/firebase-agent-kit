import { setDebugSkipTokenVerification } from '@genkit-ai/firebase/context';
import {
  defineBoolean,
  defineInt,
  defineList,
} from 'firebase-functions/params';
import { RESET_VALUE } from 'firebase-functions/v2/options';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentRequestOptions } from '../../src/types.js';
import { type ServedFunction, serveAgentFunction } from './https-function.js';

vi.hoisted(() => {
  delete process.env.FIREBASE_DEBUG_MODE;
  delete process.env.FIREBASE_DEBUG_FEATURES;
});

let served: ServedFunction | undefined;
beforeEach(() => {
  setDebugSkipTokenVerification(true);
});
afterEach(async () => {
  await served?.close();
  served = undefined;
  vi.unstubAllEnvs();
  setDebugSkipTokenVerification(false);
});

const preflight = (base: string, origin = 'https://app.example.com') =>
  fetch(base, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });

describe('onAgentRequest CORS', () => {
  test('answers a preflight with CORS headers when httpsOptions.cors is set', async () => {
    served = await serveAgentFunction({ cors: true });
    const res = await preflight(served.base);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );
    expect(res.headers.get('access-control-allow-headers')).toContain(
      'authorization',
    );
  });

  test('allows only the origins a list param holds at request time', async () => {
    served = await serveAgentFunction({
      cors: defineList('AGENT_TEST_CORS_ORIGINS'),
    });
    vi.stubEnv(
      'AGENT_TEST_CORS_ORIGINS',
      '["https://app.example.com","https://admin.example.com"]',
    );
    for (const origin of [
      'https://app.example.com',
      'https://admin.example.com',
    ]) {
      const listed = await preflight(served.base, origin);
      expect(listed.headers.get('access-control-allow-origin')).toBe(origin);
    }
    const other = await preflight(served.base, 'https://other.example.com');
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('sends no CORS headers when httpsOptions.cors is unset', async () => {
    served = await serveAgentFunction();
    const res = await preflight(served.base);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('onAgentRequest token verification in the emulator', () => {
  test('turns off token verification skipping when the Auth emulator is configured', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099');
    vi.stubEnv('GCLOUD_PROJECT', 'demo-test');
    served = await serveAgentFunction();
    const res = await served.postTurn();
    expect(res.status).toBe(403);
    expect(served.leases).toEqual([]);
  });

  test.each([
    ['outside the emulator', {}],
    ['without the Auth emulator', { FUNCTIONS_EMULATOR: 'true' }],
    ['outside the Functions emulator', { FIREBASE_AUTH_EMULATOR_HOST: 'x' }],
  ])('leaves token verification settings alone %s', async (_label, env) => {
    vi.stubEnv('FUNCTIONS_EMULATOR', undefined);
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', undefined);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    served = await serveAgentFunction();
    const res = await served.postTurn();
    expect(res.status).toBe(409);
  });
});

describe('onAgentRequest lease', () => {
  test('sizes the lease from httpsOptions.timeoutSeconds', async () => {
    served = await serveAgentFunction({ timeoutSeconds: 120 });
    await served.postTurn();
    expect(served.leases).toEqual([150_000]);
  });

  test('resolves a timeoutSeconds expression at request time', async () => {
    served = await serveAgentFunction({
      timeoutSeconds: defineInt('AGENT_TEST_TIMEOUT_SECONDS'),
    });
    vi.stubEnv('AGENT_TEST_TIMEOUT_SECONDS', '300');
    await served.postTurn();
    expect(served.leases).toEqual([330_000]);
  });

  test('uses the 60 second default when a timeoutSeconds expression is unset', async () => {
    served = await serveAgentFunction({
      timeoutSeconds: defineInt('AGENT_TEST_UNSET_TIMEOUT_SECONDS'),
    });
    await served.postTurn();
    expect(served.leases).toEqual([90_000]);
  });

  test.each([
    ['unset', undefined],
    ['RESET_VALUE', RESET_VALUE],
  ])(
    'uses the 60 second default when timeoutSeconds is %s',
    async (_label, timeoutSeconds) => {
      served = await serveAgentFunction({ timeoutSeconds });
      await served.postTurn();
      expect(served.leases).toEqual([90_000]);
    },
  );
});

describe('onAgentRequest App Check', () => {
  test('rejects a turn without an App Check token when enforceAppCheck is true', async () => {
    served = await serveAgentFunction(undefined, { enforceAppCheck: true });
    const res = await served.postTurn();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      status: 'PERMISSION_DENIED',
      message: 'AppCheck token is required',
    });
    expect(served.leases).toEqual([]);
  });

  test('enforces App Check for a truthy non-boolean value from a JavaScript caller', async () => {
    const jsCallerOptions: Pick<AgentRequestOptions, 'enforceAppCheck'> =
      JSON.parse('{ "enforceAppCheck": "true" }');
    served = await serveAgentFunction(undefined, jsCallerOptions);
    const res = await served.postTurn();
    expect(res.status).toBe(403);
  });

  test.each([
    ['true', 403],
    ['false', 409],
  ])(
    'resolves an enforceAppCheck expression set to %s at request time',
    async (value, status) => {
      served = await serveAgentFunction(undefined, {
        enforceAppCheck: defineBoolean('AGENT_TEST_ENFORCE_APP_CHECK'),
      });
      vi.stubEnv('AGENT_TEST_ENFORCE_APP_CHECK', value);
      const res = await served.postTurn();
      expect(res.status).toBe(status);
    },
  );
});
