import { setGlobalOptions } from 'firebase-functions';
import { defineBoolean, defineString } from 'firebase-functions/params';
import { type HttpsOptions, onRequest } from 'firebase-functions/v2/https';
import { RESET_VALUE } from 'firebase-functions/v2/options';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { endpointRegion } from '../../src/handler.js';

setGlobalOptions({ region: defineString('AGENT_TEST_GLOBAL_REGION') });

const regionOf = (opts: HttpsOptions = {}) =>
  endpointRegion(onRequest(opts, () => {}).__endpoint.region);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('endpointRegion', () => {
  test('reads a global region param at call time', () => {
    const fn = onRequest({}, () => {});
    vi.stubEnv('AGENT_TEST_GLOBAL_REGION', 'europe-west1');
    expect(endpointRegion(fn.__endpoint.region)).toBe('europe-west1');
  });

  test('returns undefined for a global region param without a value', () => {
    vi.stubEnv('AGENT_TEST_GLOBAL_REGION', '');
    expect(regionOf()).toBeUndefined();
  });

  test('reads a region string from the function options', () => {
    expect(regionOf({ region: 'asia-northeast1' })).toBe('asia-northeast1');
  });

  test('reads the first region of a region list', () => {
    expect(regionOf({ region: ['us-east1', 'europe-west1'] })).toBe('us-east1');
  });

  test('reads a region param from the function options', () => {
    vi.stubEnv('AGENT_TEST_FUNCTION_REGION', 'europe-west4');
    expect(
      regionOf({ region: defineString('AGENT_TEST_FUNCTION_REGION') }),
    ).toBe('europe-west4');
  });

  test('reads a region expression', () => {
    const region = defineBoolean('AGENT_TEST_IN_EU').thenElse(
      'europe-west1',
      'us-east1',
    );
    vi.stubEnv('AGENT_TEST_IN_EU', 'true');
    expect(regionOf({ region })).toBe('europe-west1');
    vi.stubEnv('AGENT_TEST_IN_EU', 'false');
    expect(regionOf({ region })).toBe('us-east1');
  });

  test('returns undefined for a reset region and for no region', () => {
    expect(regionOf({ region: RESET_VALUE })).toBeUndefined();
    expect(endpointRegion(undefined)).toBeUndefined();
  });
});
