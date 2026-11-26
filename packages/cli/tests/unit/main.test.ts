import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { main } from '../../src/main.js';
import { ConfigStore } from '../../src/store.js';
import { CancelledError } from '../../src/ui/prompt.js';

let dir: string;
let server: Server | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fak-main-'));
});
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(0)));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

const token = `h.${Buffer.from(
  JSON.stringify({ user_id: 'u1', email: 'u@x', exp: 9e9 }),
).toString('base64url')}.s`;

function run(
  argv: string[],
  opts: {
    env?: object;
    input?: string;
    tty?: boolean;
    promptPassword?: () => Promise<string>;
  } = {},
) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => {
    out += d;
  });
  stderr.on('data', (d) => {
    err += d;
  });
  const store = new ConfigStore(join(dir, 'config'));
  return main(argv, {
    env: { ...opts.env },
    cwd: join(dir, 'work'),
    stdin: Readable.from(opts.input ? [opts.input] : []),
    stdout,
    stderr,
    tty: opts.tty ?? false,
    store,
    promptPassword: opts.promptPassword ?? vi.fn(),
    promptApiKey: vi.fn(),
    pickOne: vi.fn(),
  }).then((code) => ({ code, out, err, store }));
}

beforeEach(async () => {
  await mkdir(join(dir, 'work'), { recursive: true });
});

test('--help prints usage and exits 0', async () => {
  const { code, out } = await run(['--help']);
  expect(code).toBe(0);
  expect(out).toContain('Usage: fak [instance]');
});

test('an unknown option exits 1 with the problem on stderr', async () => {
  const { code, err } = await run(['--nope']);
  expect(code).toBe(1);
  expect(err).toContain('error: Unknown option');
});

test('cancelling the password prompt exits 130', async () => {
  const { code } = await run(
    ['--url', 'http://127.0.0.1:1/agent', '--api-key', 'k', '--email', 'a@x'],
    {
      tty: true,
      promptPassword: async () => {
        throw new CancelledError();
      },
    },
  );
  expect(code).toBe(130);
});

test('without a URL, project or last target it explains what to pass', async () => {
  const { code, err } = await run([]);
  expect(code).toBe(1);
  expect(err).toContain('error: No agent to talk to');
});

test('without a terminal and no saved sign-in, it says so', async () => {
  const { code, err } = await run([
    '--url',
    'http://127.0.0.1:1/agent',
    '--api-key',
    'k',
    '--email',
    'a@x',
  ]);
  expect(code).toBe(1);
  expect(err).toContain('error: No saved sign-in');
});

test('a failed turn in plain mode exits 1 and writes to stderr', async () => {
  server = createServer((_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'PERMISSION_DENIED', message: 'no' }));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const { port } = address;
  const { code, out, err } = await run(
    ['--url', `http://127.0.0.1:${port}/agent`],
    { env: { FIREBASE_ID_TOKEN: token }, input: 'hello\n' },
  );
  expect(code).toBe(1);
  expect(err).toContain('error: Access denied');
  expect(err).toContain('FIREBASE_ID_TOKEN');
  expect(out).not.toContain('error:');
});

test('a project directory target is remembered for the next bare run', async () => {
  await writeFile(
    join(dir, 'work', 'firebase.json'),
    JSON.stringify({
      functions: [{ kit: 'k', source: 's', instances: { support: 'cfg' } }],
    }),
  );
  await writeFile(
    join(dir, 'work', '.firebaserc'),
    JSON.stringify({ projects: { default: 'my-proj' } }),
  );
  const first = await run([], { env: { FIREBASE_ID_TOKEN: token } });
  expect(first.code).toBe(0);
  expect(await first.store.getLastTarget()).toEqual({
    url: 'https://us-central1-my-proj.cloudfunctions.net/kit-support-agent',
    project: 'my-proj',
    instance: 'support',
    region: 'us-central1',
  });
  expect(first.out).toContain('kit-support-agent as u@x');
});
