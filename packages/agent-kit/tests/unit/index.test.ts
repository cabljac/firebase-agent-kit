import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const imported = vi.fn();

vi.mock('@cabljac/firebase-agent-kit-core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onAgentRequest: vi.fn(),
  onAgentTask: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.doMock('@genkit-ai/google-cloud', () => {
    imported();
    return { enableGoogleCloudTelemetry: vi.fn(async () => undefined) };
  });
  vi.stubEnv('FUNCTIONS_CONTROL_API', 'true');
  vi.stubEnv('FIREBASE_KIT_INSTANCE_ID', 'support');
  vi.stubEnv('GCLOUD_PROJECT', 'demo-test');
  vi.stubEnv('GOOGLE_CLOUD_TELEMETRY', undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/** Loads the kit entry and returns the `ready` hook each handler got. */
async function loadKit() {
  await import('../../src/index.js');
  const core = await import('@cabljac/firebase-agent-kit-core');
  const request = vi.mocked(core.onAgentRequest).mock.calls[0]?.[1];
  const task = vi.mocked(core.onAgentTask).mock.calls[0]?.[2];
  return { requestReady: request?.ready, taskReady: task?.ready };
}

async function enableMock() {
  const { enableGoogleCloudTelemetry } = await import(
    '@genkit-ai/google-cloud'
  );
  return vi.mocked(enableGoogleCloudTelemetry);
}

describe('kit entry telemetry wiring', () => {
  test('gives both handlers the same ready hook', async () => {
    const { requestReady, taskReady } = await loadKit();
    expect(requestReady).toBeTypeOf('function');
    expect(taskReady).toBe(requestReady);
  });

  test('enables Google Cloud telemetry once across both handlers when GOOGLE_CLOUD_TELEMETRY is true', async () => {
    vi.stubEnv('GOOGLE_CLOUD_TELEMETRY', 'true');
    const { requestReady, taskReady } = await loadKit();
    await Promise.all([requestReady?.(), taskReady?.(), requestReady?.()]);
    expect(await enableMock()).toHaveBeenCalledOnce();
  });

  test.each([
    ['false', 'false'],
    ['unset', undefined],
  ])(
    'never imports @genkit-ai/google-cloud when GOOGLE_CLOUD_TELEMETRY is %s',
    async (_, value) => {
      vi.stubEnv('GOOGLE_CLOUD_TELEMETRY', value);
      const { requestReady, taskReady } = await loadKit();
      await Promise.all([requestReady?.(), taskReady?.()]);
      expect(imported).not.toHaveBeenCalled();
    },
  );
});
