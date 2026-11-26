import { setDebugSkipTokenVerification } from '@genkit-ai/firebase/context';
import { setGlobalOptions } from 'firebase-functions';
import { defineInt } from 'firebase-functions/params';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type ServedFunction, serveAgentFunction } from './https-function.js';

setGlobalOptions({ timeoutSeconds: defineInt('AGENT_TEST_GLOBAL_TIMEOUT') });

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

test('sizes the lease from the global timeoutSeconds at request time', async () => {
  served = await serveAgentFunction();
  vi.stubEnv('AGENT_TEST_GLOBAL_TIMEOUT', '240');
  await served.postTurn();
  expect(served.leases).toEqual([270_000]);
});

test('prefers httpsOptions.timeoutSeconds over the global one', async () => {
  served = await serveAgentFunction({ timeoutSeconds: 120 });
  vi.stubEnv('AGENT_TEST_GLOBAL_TIMEOUT', '240');
  await served.postTurn();
  expect(served.leases).toEqual([150_000]);
});
