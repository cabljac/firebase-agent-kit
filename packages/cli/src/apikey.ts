import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './auth.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MANAGEMENT_API = 'https://firebase.googleapis.com/v1beta1';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** No usable Google credentials were found to call the Firebase Management API. */
export class NoGoogleCredentialsError extends Error {
  /** @param reason Why no credentials could be used. */
  constructor(reason: string) {
    super(reason);
    this.name = 'NoGoogleCredentialsError';
  }
}

/** A Firebase Management API call failed. */
export class ManagementApiError extends Error {
  /**
   * @param status HTTP status.
   * @param message Server message.
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ManagementApiError';
  }
}

/** An OAuth access token. */
export interface GoogleAccess {
  token: string;
  /** True for a user login; calls then bill quota to the target project. */
  user: boolean;
}

/** A web app of a project, with the API key its config holds. */
export interface WebAppKey {
  appId: string;
  displayName: string;
  apiKey: string;
}

/** Options shared by the calls in this module. */
export interface GoogleHttpOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * Returns the path of the Application Default Credentials file.
 * @param env Environment.
 * @param home Home directory.
 */
export function adcPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (env.GOOGLE_APPLICATION_CREDENTIALS)
    return env.GOOGLE_APPLICATION_CREDENTIALS;
  const gcloud =
    env.CLOUDSDK_CONFIG ??
    (process.platform === 'win32' && env.APPDATA
      ? join(env.APPDATA, 'gcloud')
      : join(home, '.config', 'gcloud'));
  return join(gcloud, 'application_default_credentials.json');
}

async function postToken(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  url = TOKEN_URL,
): Promise<string> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json: unknown = await res.json().catch(() => ({}));
  const token = isRecord(json) ? str(json.access_token) : undefined;
  if (!res.ok || !token) {
    const detail = isRecord(json)
      ? (str(json.error_description) ?? str(json.error))
      : undefined;
    throw new NoGoogleCredentialsError(
      `Google rejected the Application Default Credentials${detail ? `: ${detail}` : '.'}`,
    );
  }
  return token;
}

function signJwt(email: string, key: string, audience: string, now: number) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: email,
    scope: SCOPE,
    aud: audience,
    iat,
    exp: iat + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key);
  return `${unsigned}.${signature.toString('base64url')}`;
}

/**
 * Gets an access token from Application Default Credentials: a gcloud user
 * login (`gcloud auth application-default login`) or a service account key.
 * @param opts Optional `fetch`, environment and home directory.
 */
export async function googleAccess(
  opts: GoogleHttpOptions = {},
): Promise<GoogleAccess> {
  const fetchImpl = opts.fetch ?? fetch;
  const path = adcPath(opts.env, opts.home);
  let creds: unknown;
  try {
    creds = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new NoGoogleCredentialsError(`No readable credentials at ${path}.`);
  }
  if (!isRecord(creds)) {
    throw new NoGoogleCredentialsError(`${path} is not a credentials file.`);
  }
  if (creds.type === 'authorized_user') {
    const clientId = str(creds.client_id);
    const clientSecret = str(creds.client_secret);
    const refreshToken = str(creds.refresh_token);
    if (!clientId || !clientSecret || !refreshToken)
      throw new NoGoogleCredentialsError(`${path} is incomplete.`);
    const token = await postToken(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      fetchImpl,
    );
    return { token, user: true };
  }
  if (creds.type === 'service_account') {
    const email = str(creds.client_email);
    const key = str(creds.private_key);
    const tokenUri = str(creds.token_uri) ?? TOKEN_URL;
    if (!email || !key)
      throw new NoGoogleCredentialsError(`${path} is incomplete.`);
    const token = await postToken(
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(email, key, tokenUri, Date.now()),
      }),
      fetchImpl,
      tokenUri,
    );
    return { token, user: false };
  }
  throw new NoGoogleCredentialsError(
    `Credentials of type "${String(creds.type)}" in ${path} are not supported here.`,
  );
}

async function getJson(
  url: string,
  access: GoogleAccess,
  project: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${access.token}`,
      ...(access.user ? { 'x-goog-user-project': project } : {}),
    },
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      isRecord(json) && isRecord(json.error)
        ? str(json.error.message)
        : undefined;
    throw new ManagementApiError(res.status, message ?? `HTTP ${res.status}`);
  }
  return isRecord(json) ? json : {};
}

/**
 * Lists the web apps of a project with their API keys, through the Firebase
 * Management API.
 * @param project Firebase project id.
 * @param access Token from {@link googleAccess}.
 * @param opts Optional `fetch`.
 */
export async function listWebAppKeys(
  project: string,
  access: GoogleAccess,
  opts: GoogleHttpOptions = {},
): Promise<WebAppKey[]> {
  const fetchImpl = opts.fetch ?? fetch;
  const base = `${MANAGEMENT_API}/projects/${encodeURIComponent(project)}/webApps`;
  const list = await getJson(
    `${base}?pageSize=100`,
    access,
    project,
    fetchImpl,
  );
  const apps = Array.isArray(list.apps) ? list.apps.filter(isRecord) : [];
  const keys: WebAppKey[] = [];
  for (const app of apps) {
    const appId = str(app.appId);
    if (!appId || (app.state !== undefined && app.state !== 'ACTIVE')) continue;
    const config = await getJson(
      `${base}/${encodeURIComponent(appId)}/config`,
      access,
      project,
      fetchImpl,
    );
    const apiKey = str(config.apiKey);
    if (apiKey)
      keys.push({ appId, displayName: str(app.displayName) ?? appId, apiKey });
  }
  return keys;
}

/** Options for {@link projectApiKey}. */
export interface ProjectApiKeyOptions extends GoogleHttpOptions {
  project: string;
  /** Asks the user to choose a web app when apps use different keys. */
  pickApp?: (apps: WebAppKey[]) => Promise<WebAppKey>;
}

/**
 * Finds the web API key of a project from its web app configs. When every
 * web app uses the same key, it returns that key without asking.
 * @param opts See {@link ProjectApiKeyOptions}.
 */
export async function projectApiKey(
  opts: ProjectApiKeyOptions,
): Promise<string> {
  const access = await googleAccess(opts);
  const apps = await listWebAppKeys(opts.project, access, opts);
  const distinct = [...new Set(apps.map((a) => a.apiKey))];
  if (distinct.length === 0) {
    throw new UsageError(
      `Project ${opts.project} has no web app. Add one in the Firebase console, or pass --api-key.`,
      'No web app',
    );
  }
  if (distinct.length === 1 && distinct[0]) return distinct[0];
  if (!opts.pickApp) {
    throw new UsageError(
      `The web apps of ${opts.project} use different API keys. Pass --api-key.`,
      'Several web apps',
    );
  }
  return (await opts.pickApp(apps)).apiKey;
}
