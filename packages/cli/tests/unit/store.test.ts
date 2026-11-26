import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ConfigFileError, ConfigStore, configDir } from '../../src/store.js';

let root: string;
let store: ConfigStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-chat-store-'));
  store = new ConfigStore(join(root, 'genkit-agent-chat'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const cred = (email: string, refreshToken = 'rt') => ({
  email,
  uid: `uid-${email}`,
  refreshToken,
});

test('configDir prefers XDG_CONFIG_HOME, then the platform default', () => {
  expect(configDir({ XDG_CONFIG_HOME: '/x' }, 'darwin', '/h')).toBe(
    '/x/genkit-agent-chat',
  );
  expect(configDir({}, 'darwin', '/h')).toBe(
    '/h/Library/Application Support/genkit-agent-chat',
  );
  expect(configDir({}, 'linux', '/h')).toBe('/h/.config/genkit-agent-chat');
  expect(configDir({ APPDATA: 'C:/AppData' }, 'win32', '/h')).toBe(
    join('C:/AppData', 'genkit-agent-chat'),
  );
});

test.skipIf(process.platform === 'win32')(
  'writes files with mode 0600 in a directory with mode 0700',
  async () => {
    await store.saveCredential('key', cred('a@example.com'));
    await store.setLastSession('https://x', 'uid', 's1');
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
    for (const file of ['credentials.json', 'state.json']) {
      expect((await stat(join(store.dir, file))).mode & 0o777).toBe(0o600);
    }
  },
);

test('does not store the API key in clear text', async () => {
  await store.saveCredential('secret-api-key', cred('a@example.com'));
  const text = await readFile(join(store.dir, 'credentials.json'), 'utf8');
  expect(text).not.toContain('secret-api-key');
});

test('keys saved sign-ins by API key and email, and remembers the last email', async () => {
  await store.saveCredential('key', cred('a@example.com', 'rt-a'));
  await store.saveCredential('key', cred('b@example.com', 'rt-b'));
  await store.saveCredential('other', cred('a@example.com', 'rt-other'));

  expect(
    (await store.getCredential('key', 'A@example.com'))?.refreshToken,
  ).toBe('rt-a');
  expect((await store.getCredential('key'))?.refreshToken).toBe('rt-b');
  expect((await store.getCredential('other'))?.refreshToken).toBe('rt-other');

  await store.setLastEmail('key', 'a@example.com');
  expect((await store.getCredential('key'))?.refreshToken).toBe('rt-a');
});

test('logout deletes one sign-in and removes the file when it is empty', async () => {
  await store.saveCredential('key', cred('a@example.com'));
  await store.saveCredential('key', cred('b@example.com'));

  expect(await store.deleteCredential('key', 'a@example.com')).toBe(
    'a@example.com',
  );
  expect(await store.getCredential('key', 'a@example.com')).toBeUndefined();
  expect(await store.getCredential('key', 'b@example.com')).toBeDefined();

  expect(await store.deleteCredential('key')).toBe('b@example.com');
  await expect(stat(join(store.dir, 'credentials.json'))).rejects.toThrow();
  expect(await store.deleteCredential('key')).toBeUndefined();
});

test('remembers the last session per URL and user', async () => {
  await store.setLastSession('https://a', 'u1', 's1');
  await store.setLastSession('https://a', 'u2', 's2');
  await store.setLastSession('https://b', 'u1', 's3');
  expect(await store.getLastSession('https://a', 'u1')).toBe('s1');
  expect(await store.getLastSession('https://a', 'u2')).toBe('s2');
  expect(await store.getLastSession('https://b', 'u1')).toBe('s3');
  expect(await store.getLastSession('https://b', 'u2')).toBeUndefined();
});

test('refuses a file that is not JSON, and leaves it alone', async () => {
  await store.saveCredential('key', cred('a@example.com'));
  const path = join(store.dir, 'credentials.json');
  await writeFile(path, '{not json');
  await expect(store.getCredential('key')).rejects.toBeInstanceOf(
    ConfigFileError,
  );
  await expect(
    store.saveCredential('key', cred('b@example.com')),
  ).rejects.toThrow('is not valid JSON');
  expect(await readFile(path, 'utf8')).toBe('{not json');
});

test('refuses a file with the wrong shape', async () => {
  await store.setLastSession('https://a', 'u1', 's1');
  await writeFile(join(store.dir, 'credentials.json'), '{"credentials":null}');
  await expect(store.getCredential('key')).rejects.toThrow(
    'has an unexpected shape',
  );
  await writeFile(
    join(store.dir, 'credentials.json'),
    '{"credentials":{"x":{"email":"a"}}}',
  );
  await expect(store.getCredential('key')).rejects.toThrow(ConfigFileError);
});

test('ignores a relative XDG_CONFIG_HOME', () => {
  expect(configDir({ XDG_CONFIG_HOME: 'rel' }, 'linux', '/h')).toBe(
    '/h/.config/genkit-agent-chat',
  );
});

test.skipIf(process.platform === 'win32')(
  'tightens a pre-existing directory to mode 0700',
  async () => {
    await mkdir(store.dir, { recursive: true, mode: 0o755 });
    await chmod(store.dir, 0o755);
    await store.setLastSession('https://a', 'u', 's');
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
  },
);

test('leaves no temporary files behind', async () => {
  await store.saveCredential('key', cred('a@example.com'));
  await store.setLastSession('https://a', 'u', 's');
  expect((await readdir(store.dir)).sort()).toEqual([
    'credentials.json',
    'state.json',
  ]);
});

test('remembers the last target and API keys per project', async () => {
  await store.setLastTarget({
    url: 'https://x',
    project: 'p',
    instance: 'i',
    region: 'r',
  });
  await store.setApiKey('p', 'key-p');
  expect(await store.getLastTarget()).toEqual({
    url: 'https://x',
    project: 'p',
    instance: 'i',
    region: 'r',
  });
  expect(await store.getApiKey('p')).toBe('key-p');
  expect(await store.getApiKey('q')).toBeUndefined();
});
