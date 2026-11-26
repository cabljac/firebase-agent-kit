import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { UsageError } from '../../src/auth.js';
import {
  findProjectRoot,
  instanceRegion,
  parseDotenv,
  readProject,
} from '../../src/discover.js';
import { resolveTarget } from '../../src/target.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-chat-target-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, content: string) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}

async function project(opts: {
  instances: Record<string, string>;
  rc?: object;
  envs?: Record<string, string>;
}) {
  await write(
    'firebase.json',
    JSON.stringify({
      functions: [
        { source: 'functions', codebase: 'default' },
        {
          kit: 'genkit-agent-kit',
          source: 'function-kits/genkit-agent-kit/source',
          instances: opts.instances,
        },
      ],
    }),
  );
  if (opts.rc) await write('.firebaserc', JSON.stringify(opts.rc));
  for (const [path, content] of Object.entries(opts.envs ?? {}))
    await write(path, content);
}

const kitDir = (id: string) => `function-kits/genkit-agent-kit/config-${id}`;

test('builds the URL of the only instance from firebase.json and .firebaserc', async () => {
  await project({
    instances: { support: kitDir('support') },
    rc: { projects: { default: 'my-proj' } },
    envs: {
      [`${kitDir('support')}/.env.my-proj`]:
        'FUNCTION_DEFAULT_REGION=europe-west1\nMEMORY=512\n',
    },
  });
  await mkdir(join(root, 'src/deep'), { recursive: true });
  expect(await resolveTarget({ cwd: join(root, 'src/deep') })).toEqual({
    url: 'https://europe-west1-my-proj.cloudfunctions.net/kit-support-agent',
    project: 'my-proj',
    instance: 'support',
    region: 'europe-west1',
  });
});

test('asks which instance when there are several, or fails without a picker', async () => {
  await project({
    instances: { support: kitDir('support'), sales: kitDir('sales') },
    rc: { projects: { default: 'p' } },
  });
  const pickInstance = vi.fn(async (ids: string[]) => ids[1] ?? '');
  const target = await resolveTarget({ cwd: root, pickInstance });
  expect(pickInstance).toHaveBeenCalledWith(['support', 'sales']);
  expect(target.instance).toBe('sales');
  expect(target.region).toBe('us-central1');
  await expect(resolveTarget({ cwd: root })).rejects.toThrow(
    'several kit instances: support, sales',
  );
  expect((await resolveTarget({ cwd: root, instance: 'support' })).url).toBe(
    'https://us-central1-p.cloudfunctions.net/kit-support-agent',
  );
});

test('needs --project when .firebaserc is missing', async () => {
  await project({ instances: { support: kitDir('support') } });
  await expect(resolveTarget({ cwd: root })).rejects.toMatchObject({
    title: 'No Firebase project',
  });
  expect((await resolveTarget({ cwd: root, project: 'other' })).project).toBe(
    'other',
  );
});

test('--project may be an alias, and the alias .env file wins', async () => {
  await project({
    instances: { support: kitDir('support') },
    rc: { projects: { default: 'p-dev', prod: 'p-prod' } },
    envs: {
      [`${kitDir('support')}/.env`]: 'FUNCTION_DEFAULT_REGION=asia-east1',
      [`${kitDir('support')}/.env.p-prod`]:
        'FUNCTION_DEFAULT_REGION=europe-west1',
      [`${kitDir('support')}/.env.prod`]:
        'FUNCTION_DEFAULT_REGION="us-east1" # comment',
    },
  });
  const prod = await resolveTarget({ cwd: root, project: 'prod' });
  expect(prod).toMatchObject({ project: 'p-prod', region: 'us-east1' });
  const dev = await resolveTarget({ cwd: root });
  expect(dev).toMatchObject({ project: 'p-dev', region: 'asia-east1' });
  expect(
    (await resolveTarget({ cwd: root, region: 'southamerica-east1' })).region,
  ).toBe('southamerica-east1');
});

test('rejects an unknown instance unless --project is given', async () => {
  await project({
    instances: { support: kitDir('support') },
    rc: { projects: { default: 'p' } },
  });
  await expect(
    resolveTarget({ cwd: root, instance: 'nope' }),
  ).rejects.toMatchObject({ title: 'Unknown instance' });
});

test('outside a project, uses an instance with --project, or the last target', async () => {
  expect(
    await resolveTarget({ cwd: root, instance: 'support', project: 'p' }),
  ).toMatchObject({
    url: 'https://us-central1-p.cloudfunctions.net/kit-support-agent',
  });
  const last = { url: 'https://saved', project: 'p', instance: 'i' };
  expect(await resolveTarget({ cwd: root, last })).toBe(last);
  await expect(resolveTarget({ cwd: root })).rejects.toBeInstanceOf(UsageError);
  await expect(
    resolveTarget({ cwd: root, instance: 'support' }),
  ).rejects.toThrow('Pass --project');
});

test('--url wins over everything', async () => {
  expect(await resolveTarget({ cwd: root, url: 'https://x' })).toEqual({
    url: 'https://x',
  });
});

test('readProject accepts a single functions object and skips non-kit configs', async () => {
  await write(
    'firebase.json',
    JSON.stringify({
      functions: { kit: 'k', source: 's', instances: { a: 'cfg/a' } },
    }),
  );
  const found = await readProject(root);
  expect(found.instances).toEqual([
    { id: 'a', configDir: join(root, 'cfg/a') },
  ]);
  expect(await findProjectRoot(join(root, 'cfg'))).toBe(root);
});

test('parseDotenv reads quotes, export and comments', () => {
  expect(
    parseDotenv(
      '# c\nexport A=1\nB="two words"\nC=\'x\'\nD=4 # trailing\nbad line\n',
    ),
  ).toEqual({ A: '1', B: 'two words', C: 'x', D: '4' });
});

test('instanceRegion defaults to us-central1', async () => {
  expect(await instanceRegion(join(root, 'none'), 'p')).toBe('us-central1');
});
