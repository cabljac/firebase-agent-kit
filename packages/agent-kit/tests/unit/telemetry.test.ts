import { enableGoogleCloudTelemetry } from '@genkit-ai/google-cloud';
import { logger } from 'firebase-functions';
import { genkit, z } from 'genkit';
import { enableTelemetry } from 'genkit/tracing';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { googleCloudTelemetryReady } from '../../src/lib.js';

vi.mock('firebase-functions', () => ({ logger: { error: vi.fn() } }));
vi.mock('@genkit-ai/google-cloud', () => ({
  enableGoogleCloudTelemetry: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

describe('googleCloudTelemetryReady', () => {
  test('does not enable telemetry when the param is false', async () => {
    const ready = googleCloudTelemetryReady(() => false);
    await ready();
    await ready();
    expect(enableGoogleCloudTelemetry).not.toHaveBeenCalled();
  });

  test('enables Google Cloud telemetry once over many calls when the param is true', async () => {
    const enabled = vi.fn(() => true);
    const ready = googleCloudTelemetryReady(enabled);
    await Promise.all([ready(), ready()]);
    await ready();
    expect(enabled).toHaveBeenCalledOnce();
    expect(enableGoogleCloudTelemetry).toHaveBeenCalledOnce();
    expect(enableGoogleCloudTelemetry).toHaveBeenCalledWith();
  });

  test('reads the param only on the first call', () => {
    const enabled = vi.fn(() => true);
    googleCloudTelemetryReady(enabled);
    expect(enabled).not.toHaveBeenCalled();
  });

  test('resolves and logs the cause when enableGoogleCloudTelemetry rejects', async () => {
    const err = new Error('no credentials');
    vi.mocked(enableGoogleCloudTelemetry).mockRejectedValueOnce(err);
    await expect(googleCloudTelemetryReady(() => true)()).resolves.toBe(
      undefined,
    );
    await nextTick();
    expect(logger.error).toHaveBeenCalledWith(
      'Agent kit could not enable Google Cloud telemetry. Agent turns on this instance fail until it restarts.',
      err,
    );
  });

  test('rejects on every call and logs the cause when the module cannot load', async () => {
    vi.resetModules();
    vi.doMock('@genkit-ai/google-cloud', () => {
      throw new Error('module missing');
    });
    try {
      const ready = googleCloudTelemetryReady(() => true);
      const first = ready();
      await expect(first).rejects.toThrow();
      expect(ready()).toBe(first);
      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'Agent kit could not enable Google Cloud telemetry. Agent turns on this instance fail until it restarts.',
        expect.anything(),
      );
    } finally {
      vi.doUnmock('@genkit-ai/google-cloud');
    }
  });
});

describe('Genkit with a rejected telemetry setup', () => {
  test('fails every flow run with the setup error', async () => {
    const ai = genkit({});
    const flow = ai.defineFlow(
      { name: 'telemetryProbe', inputSchema: z.string() },
      async (s) => `${s}!`,
    );
    const err = new Error('no credentials');
    await expect(enableTelemetry(Promise.reject(err))).rejects.toBe(err);
    await expect(flow('hi')).rejects.toBe(err);
    await expect(flow('hi')).rejects.toBe(err);
  });
});
