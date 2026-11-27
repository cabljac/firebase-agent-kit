import { enableGoogleCloudTelemetry } from '@genkit-ai/google-cloud';
import { logger, onInit } from 'firebase-functions';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { enableTelemetryAtColdStart } from '../../src/lib.js';

vi.mock('firebase-functions', () => ({
  logger: { error: vi.fn() },
  onInit: vi.fn(),
}));
vi.mock('@genkit-ai/google-cloud', () => ({
  enableGoogleCloudTelemetry: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/** Runs the callback that `enableTelemetryAtColdStart` gave `onInit`. */
async function runInit() {
  expect(onInit).toHaveBeenCalledOnce();
  await vi.mocked(onInit).mock.calls[0]?.[0]();
}

describe('enableTelemetryAtColdStart', () => {
  test('enables nothing when the param is false', async () => {
    enableTelemetryAtColdStart(() => false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onInit).not.toHaveBeenCalled();
    expect(enableGoogleCloudTelemetry).not.toHaveBeenCalled();
  });

  test('enables Google Cloud telemetry once before the first invocation when the param is true', async () => {
    enableTelemetryAtColdStart(() => true);
    await runInit();
    await runInit();
    expect(enableGoogleCloudTelemetry).toHaveBeenCalledOnce();
    expect(enableGoogleCloudTelemetry).toHaveBeenCalledWith();
  });

  test('does not read the param during deploy discovery', () => {
    vi.stubEnv('FUNCTIONS_CONTROL_API', 'true');
    const enabled = vi.fn(() => true);
    enableTelemetryAtColdStart(enabled);
    expect(enabled).not.toHaveBeenCalled();
    expect(onInit).not.toHaveBeenCalled();
    expect(enableGoogleCloudTelemetry).not.toHaveBeenCalled();
  });

  test('logs a failed enable instead of failing the invocation', async () => {
    const err = new Error('no credentials');
    vi.mocked(enableGoogleCloudTelemetry).mockRejectedValueOnce(err);
    enableTelemetryAtColdStart(() => true);
    await runInit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(
      'Agent kit could not enable Google Cloud telemetry.',
      err,
    );
  });
});
