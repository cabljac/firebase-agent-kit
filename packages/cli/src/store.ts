import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** A saved sign-in for one (auth scope, email) pair. */
export interface SavedCredential {
  email: string;
  uid: string;
  refreshToken: string;
}

/** The agent the last run talked to, and how its URL was found. */
export interface SavedTarget {
  url: string;
  project?: string;
  instance?: string;
  region?: string;
}

interface CredentialsFile {
  /** Keyed by {@link credentialKey}. */
  credentials: Record<string, SavedCredential>;
  /** Last email used per auth scope hash. */
  lastEmail: Record<string, string>;
}

interface StateFile {
  /** Last session id, keyed by `<url> <uid>`. */
  lastSession: Record<string, string>;
  lastTarget?: SavedTarget;
  /** Firebase web API key per project id. It is public config. */
  apiKeys: Record<string, string>;
}

/** A config file that is not valid; it is left untouched. */
export class ConfigFileError extends Error {
  /**
   * @param path The file.
   * @param reason What is wrong with it.
   */
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path} ${reason}`);
    this.name = 'ConfigFileError';
  }
}

/**
 * Returns the directory for this tool's files. It uses `XDG_CONFIG_HOME` when
 * it is an absolute path, otherwise the platform default.
 * @param env Environment to read.
 * @param platform Value of `process.platform`.
 * @param home Home directory.
 */
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  let base: string;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) base = xdg;
  else if (platform === 'win32' && env.APPDATA) base = env.APPDATA;
  else if (platform === 'darwin')
    base = join(home, 'Library', 'Application Support');
  else base = join(home, '.config');
  return join(base, 'genkit-agent-chat');
}

const hashKey = (scope: string) =>
  createHash('sha256').update(scope).digest('hex').slice(0, 16);

const credentialKey = (scope: string, email: string) =>
  `${hashKey(scope)} ${email.toLowerCase()}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((v) => typeof v === 'string');

const isCredential = (value: unknown): value is SavedCredential =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  typeof value.uid === 'string' &&
  typeof value.refreshToken === 'string';

const isTarget = (value: unknown): value is SavedTarget =>
  isRecord(value) &&
  typeof value.url === 'string' &&
  ['project', 'instance', 'region'].every(
    (k) => value[k] === undefined || typeof value[k] === 'string',
  );

function parseCredentials(value: unknown): CredentialsFile | undefined {
  if (!isRecord(value)) return undefined;
  const { credentials = {}, lastEmail = {} } = value;
  if (!isRecord(credentials) || !isStringMap(lastEmail)) return undefined;
  const entries = Object.entries(credentials);
  const valid = entries.filter((e): e is [string, SavedCredential] =>
    isCredential(e[1]),
  );
  if (valid.length !== entries.length) return undefined;
  return { credentials: Object.fromEntries(valid), lastEmail };
}

function parseState(value: unknown): StateFile | undefined {
  if (!isRecord(value)) return undefined;
  const { lastSession = {}, lastTarget, apiKeys = {} } = value;
  if (!isStringMap(lastSession) || !isStringMap(apiKeys)) return undefined;
  if (lastTarget !== undefined && !isTarget(lastTarget)) return undefined;
  return { lastSession, lastTarget, apiKeys };
}

/**
 * Reads and writes the files that hold saved sign-ins, last sessions, the
 * last target and cached API keys. Every file is written with mode 0600 in a
 * directory with mode 0700, because the credentials file holds refresh
 * tokens. A file that is not valid is never overwritten: reading it throws a
 * {@link ConfigFileError}.
 */
export class ConfigStore {
  /** @param dir Directory for the files, see {@link configDir}. */
  constructor(readonly dir: string = configDir()) {}

  private get credentialsPath() {
    return join(this.dir, 'credentials.json');
  }

  private get statePath() {
    return join(this.dir, 'state.json');
  }

  private async read<T>(
    path: string,
    parse: (value: unknown) => T | undefined,
    empty: T,
  ): Promise<T> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT')
        return empty;
      throw err;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ConfigFileError(path, 'is not valid JSON.');
    }
    const parsed = parse(value);
    if (!parsed) throw new ConfigFileError(path, 'has an unexpected shape.');
    return parsed;
  }

  private async write(path: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(tmp, path);
  }

  private readCredentials() {
    return this.read(this.credentialsPath, parseCredentials, {
      credentials: {},
      lastEmail: {},
    });
  }

  private readState() {
    return this.read(this.statePath, parseState, {
      lastSession: {},
      apiKeys: {},
    });
  }

  /**
   * Returns the saved sign-in for `scope` and `email`. Without `email`, it
   * returns the last one used with `scope`.
   * @param scope See `authScope` in `auth.ts`.
   * @param email The account email.
   */
  async getCredential(
    scope: string,
    email?: string,
  ): Promise<SavedCredential | undefined> {
    const file = await this.readCredentials();
    const target = email ?? file.lastEmail[hashKey(scope)];
    if (!target) return undefined;
    return file.credentials[credentialKey(scope, target)];
  }

  /**
   * Saves a sign-in and marks its email as the last one used.
   * @param scope See `authScope` in `auth.ts`.
   * @param cred The sign-in.
   */
  async saveCredential(scope: string, cred: SavedCredential): Promise<void> {
    const file = await this.readCredentials();
    file.credentials[credentialKey(scope, cred.email)] = cred;
    file.lastEmail[hashKey(scope)] = cred.email;
    await this.write(this.credentialsPath, file);
  }

  /**
   * Marks `email` as the last one used with `scope`.
   * @param scope See `authScope` in `auth.ts`.
   * @param email The account email.
   */
  async setLastEmail(scope: string, email: string): Promise<void> {
    const file = await this.readCredentials();
    if (file.lastEmail[hashKey(scope)] === email) return;
    file.lastEmail[hashKey(scope)] = email;
    await this.write(this.credentialsPath, file);
  }

  /**
   * Deletes the saved sign-in for `scope` and `email` (default: the last
   * email used). Returns the email it deleted, if any.
   * @param scope See `authScope` in `auth.ts`.
   * @param email The account email.
   */
  async deleteCredential(
    scope: string,
    email?: string,
  ): Promise<string | undefined> {
    const file = await this.readCredentials();
    const target = email ?? file.lastEmail[hashKey(scope)];
    if (!target) return undefined;
    const key = credentialKey(scope, target);
    const existed = key in file.credentials;
    delete file.credentials[key];
    if (file.lastEmail[hashKey(scope)]?.toLowerCase() === target.toLowerCase())
      delete file.lastEmail[hashKey(scope)];
    if (Object.keys(file.credentials).length === 0) {
      await rm(this.credentialsPath, { force: true });
    } else {
      await this.write(this.credentialsPath, file);
    }
    return existed ? target : undefined;
  }

  /**
   * Returns the last session id used with `url` by `uid`.
   * @param url Agent URL.
   * @param uid Firebase user id.
   */
  async getLastSession(url: string, uid: string): Promise<string | undefined> {
    return (await this.readState()).lastSession[`${url} ${uid}`];
  }

  /**
   * Records the last session id used with `url` by `uid`.
   * @param url Agent URL.
   * @param uid Firebase user id.
   * @param sessionId The session.
   */
  async setLastSession(
    url: string,
    uid: string,
    sessionId: string,
  ): Promise<void> {
    const file = await this.readState();
    if (file.lastSession[`${url} ${uid}`] === sessionId) return;
    file.lastSession[`${url} ${uid}`] = sessionId;
    await this.write(this.statePath, file);
  }

  /** Returns the agent the last run talked to. */
  async getLastTarget(): Promise<SavedTarget | undefined> {
    return (await this.readState()).lastTarget;
  }

  /**
   * Records the agent this run talks to.
   * @param target The URL and how it was found.
   */
  async setLastTarget(target: SavedTarget): Promise<void> {
    const file = await this.readState();
    file.lastTarget = target;
    await this.write(this.statePath, file);
  }

  /**
   * Returns the cached web API key of a project.
   * @param project Firebase project id.
   */
  async getApiKey(project: string): Promise<string | undefined> {
    return (await this.readState()).apiKeys[project];
  }

  /**
   * Caches the web API key of a project.
   * @param project Firebase project id.
   * @param apiKey Firebase web API key.
   */
  async setApiKey(project: string, apiKey: string): Promise<void> {
    const file = await this.readState();
    file.apiKeys[project] = apiKey;
    await this.write(this.statePath, file);
  }
}
