import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const appDir = join(import.meta.dirname, 'app');
const sdkBin = join(
  appDir,
  'node_modules/firebase-functions/lib/bin/firebase-functions.js',
);

let outDir: string;
beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'agent-kit-manifest-'));
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

/** Runs deploy discovery the way firebase-tools does for one kit instance. */
async function discover(instanceId: string) {
  const manifestPath = join(outDir, `${instanceId}.json`);
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [sdkBin, appDir],
    {
      cwd: appDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FUNCTIONS_CONTROL_API: 'true',
        FUNCTIONS_MANIFEST_OUTPUT_PATH: manifestPath,
        GCLOUD_PROJECT: 'demo-test',
        FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-test' }),
        FIREBASE_KIT_INSTANCE_ID: instanceId,
      },
    },
  );
  return {
    output: stdout + stderr,
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
  };
}

describe('deploy discovery', () => {
  test('finds only the agent function in a wrapper that re-exports ai', async () => {
    const { manifest } = await discover('support');
    expect(Object.keys(manifest.endpoints)).toEqual(['agent']);
  });

  test('declares the kit params and binds the function options to them', async () => {
    const { manifest } = await discover('support');
    expect(manifest.endpoints.agent).toMatchObject({
      timeoutSeconds: '{{ params.TIMEOUT_SECONDS }}',
      availableMemoryMb: '{{ params.MEMORY }}',
    });
    expect(
      manifest.params.map((p: { name: string; type: string }) => [
        p.name,
        p.type,
      ]),
    ).toEqual([
      ['CORS_ORIGINS', 'list'],
      ['TIMEOUT_SECONDS', 'int'],
      ['MEMORY', 'int'],
      ['ENFORCE_APP_CHECK', 'boolean'],
      ['VERTEX_LOCATION', 'string'],
    ]);
    expect(manifest.params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'CORS_ORIGINS', default: [] }),
        expect.objectContaining({ name: 'TIMEOUT_SECONDS', default: 60 }),
        expect.objectContaining({ name: 'MEMORY', default: 256 }),
        expect.objectContaining({ name: 'ENFORCE_APP_CHECK', default: false }),
        expect.objectContaining({
          name: 'VERTEX_LOCATION',
          default: 'us-central1',
        }),
      ]),
    );
  });

  test.each([
    ['support', 'a prompt and tools'],
    ['missing', 'no prompt'],
    ['skilled', 'skills'],
    ['badskill', 'a skill without a description'],
  ])(
    'reads no param value and runs no prompt check or skills scan for %s (%s)',
    async (instanceId) => {
      const { output, manifest } = await discover(instanceId);
      expect(Object.keys(manifest.endpoints)).toEqual(['agent']);
      expect(output).not.toContain('invoked during function deployment');
      expect(output).not.toContain('Agent kit');
      expect(output).not.toContain('skills from disk');
    },
  );
});
