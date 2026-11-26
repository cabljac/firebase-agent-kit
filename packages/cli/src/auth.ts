import type { ConfigStore } from './store.js';

/** Refresh the ID token when it has less than this much time left. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Error codes that mean a saved refresh token can never work again. */
const DEAD_REFRESH_TOKEN = new Set([
  'INVALID_REFRESH_TOKEN',
  'TOKEN_EXPIRED',
  'USER_DISABLED',
  'USER_NOT_FOUND',
  'INVALID_GRANT_TYPE',
  'MISSING_REFRESH_TOKEN',
]);

/** A failed Firebase Auth REST call, with the Firebase error code. */
export class AuthError extends Error {
  /**
   * @param code Firebase error code, for example `INVALID_LOGIN_CREDENTIALS`.
   * @param message Human-readable message.
   */
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AuthError';
  }
}

/** The {@link AuthError} code for a request that never reached Firebase Auth. */
export const AUTH_NETWORK_ERROR = 'NETWORK_REQUEST_FAILED';

/**
 * The value for keying saved sign-ins: the API key, plus the Auth emulator
 * host when one is set, so emulator and production sign-ins never mix.
 * @param apiKey Firebase web API key.
 * @param env Environment to read `FIREBASE_AUTH_EMULATOR_HOST` from.
 */
export function authScope(
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const host = env.FIREBASE_AUTH_EMULATOR_HOST;
  return host ? `${apiKey} emulator:${host}` : apiKey;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The signed-in user, as shown in the header and used to key sessions. */
export interface AuthUser {
  uid: string;
  email?: string;
}

/** Supplies an ID token for each request. */
export interface TokenSource {
  readonly user: AuthUser;
  /** Returns a valid ID token, refreshing it first when needed. */
  getIdToken(): Promise<string>;
}

/** Options shared by the Firebase Auth REST calls. */
export interface AuthHttpOptions {
  apiKey: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Result of a sign-in or a token refresh. */
export interface TokenGrant {
  idToken: string;
  refreshToken: string;
  /** Seconds until `idToken` expires. */
  expiresIn: number;
  uid: string;
}

function endpoint(
  service: 'identitytoolkit' | 'securetoken',
  path: string,
  { apiKey, env = process.env }: AuthHttpOptions,
): string {
  const host = env.FIREBASE_AUTH_EMULATOR_HOST;
  const base = host
    ? `http://${host}/${service}.googleapis.com`
    : `https://${service}.googleapis.com`;
  return `${base}${path}?key=${encodeURIComponent(apiKey)}`;
}

async function post(
  url: string,
  body: string,
  contentType: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
  } catch (err) {
    throw new AuthError(AUTH_NETWORK_ERROR, 'Cannot reach Firebase Auth.', {
      cause: err,
    });
  }
  const parsed: unknown = await res.json().catch(() => ({}));
  const json = isRecord(parsed) ? parsed : {};
  if (!res.ok) {
    const message = isRecord(json.error) ? json.error.message : undefined;
    const raw = typeof message === 'string' ? message : `HTTP_${res.status}`;
    const [code = raw, ...rest] = raw.split(' : ');
    throw new AuthError(code, rest.join(' : ') || code);
  }
  return json;
}

/**
 * Signs in with email and password through the Identity Toolkit REST API.
 * @param opts API key, credentials, and an optional `fetch` and environment.
 */
export async function signInWithPassword(
  opts: AuthHttpOptions & { email: string; password: string },
): Promise<TokenGrant> {
  const json = await post(
    endpoint('identitytoolkit', '/v1/accounts:signInWithPassword', opts),
    JSON.stringify({
      email: opts.email,
      password: opts.password,
      returnSecureToken: true,
    }),
    'application/json',
    opts.fetch ?? fetch,
  );
  return {
    idToken: String(json.idToken),
    refreshToken: String(json.refreshToken),
    expiresIn: Number(json.expiresIn),
    uid: String(json.localId),
  };
}

/**
 * Exchanges a refresh token for a new ID token through the Secure Token API.
 * @param opts API key, refresh token, and an optional `fetch` and environment.
 */
export async function refreshIdToken(
  opts: AuthHttpOptions & { refreshToken: string },
): Promise<TokenGrant> {
  const json = await post(
    endpoint('securetoken', '/v1/token', opts),
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
    }).toString(),
    'application/x-www-form-urlencoded',
    opts.fetch ?? fetch,
  );
  return {
    idToken: String(json.id_token),
    refreshToken: String(json.refresh_token),
    expiresIn: Number(json.expires_in),
    uid: String(json.user_id),
  };
}

/**
 * Reads the claims of a Firebase ID token without verifying it. The server
 * verifies the token; the client only needs the uid and email for display.
 * @param token A JWT.
 */
export function decodeIdToken(token: string): AuthUser & { exp?: number } {
  const payload = token.split('.')[1];
  if (!payload) throw new AuthError('INVALID_ID_TOKEN', 'Not a JWT.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('INVALID_ID_TOKEN', 'The token payload is not JSON.');
  }
  const claims = isRecord(parsed) ? parsed : {};
  const uid = claims.user_id ?? claims.sub;
  if (typeof uid !== 'string' || !uid)
    throw new AuthError('INVALID_ID_TOKEN', 'The token has no user id.');
  return {
    uid,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    exp: typeof claims.exp === 'number' ? claims.exp : undefined,
  };
}

/**
 * A fixed ID token, for example one passed with `--id-token`. It cannot be
 * refreshed, so it fails with `ID_TOKEN_EXPIRED` once its `exp` has passed.
 */
export class StaticTokenSource implements TokenSource {
  readonly user: AuthUser;
  private readonly expiresAt?: number;

  /**
   * @param idToken Firebase ID token.
   * @param now Clock, in epoch milliseconds.
   */
  constructor(
    private readonly idToken: string,
    private readonly now: () => number = Date.now,
  ) {
    const { uid, email, exp } = decodeIdToken(idToken);
    this.user = { uid, email };
    this.expiresAt = exp === undefined ? undefined : exp * 1000;
    this.check();
  }

  async getIdToken(): Promise<string> {
    this.check();
    return this.idToken;
  }

  private check(): void {
    if (this.expiresAt !== undefined && this.now() >= this.expiresAt) {
      throw new AuthError(
        'ID_TOKEN_EXPIRED',
        `The ID token expired at ${new Date(this.expiresAt).toISOString()}.`,
      );
    }
  }
}

/** Options for {@link RefreshingTokenSource}. */
export interface RefreshingTokenSourceOptions extends AuthHttpOptions {
  user: AuthUser;
  refreshToken: string;
  /** A current ID token, if one is already known. */
  idToken?: string;
  /** When `idToken` expires, in epoch milliseconds. */
  expiresAt?: number;
  now?: () => number;
  /** Called when the server issues a different refresh token. */
  onRefreshToken?: (refreshToken: string) => Promise<void> | void;
}

/**
 * Keeps an ID token fresh with a refresh token. It refreshes when the token
 * has less than {@link REFRESH_MARGIN_MS} left, and shares one refresh between
 * concurrent callers.
 */
export class RefreshingTokenSource implements TokenSource {
  readonly user: AuthUser;
  private refreshToken: string;
  private idToken?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;
  private readonly now: () => number;

  /** @param opts See {@link RefreshingTokenSourceOptions}. */
  constructor(private readonly opts: RefreshingTokenSourceOptions) {
    this.user = opts.user;
    this.refreshToken = opts.refreshToken;
    this.idToken = opts.idToken;
    this.expiresAt = opts.expiresAt ?? 0;
    this.now = opts.now ?? Date.now;
  }

  getIdToken(): Promise<string> {
    if (this.idToken && this.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return Promise.resolve(this.idToken);
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const grant = await refreshIdToken({
      ...this.opts,
      refreshToken: this.refreshToken,
    });
    this.idToken = grant.idToken;
    this.expiresAt = this.now() + grant.expiresIn * 1000;
    if (grant.refreshToken && grant.refreshToken !== this.refreshToken) {
      this.refreshToken = grant.refreshToken;
      await this.opts.onRefreshToken?.(grant.refreshToken);
    }
    return grant.idToken;
  }
}

/** A problem with the command line options, shown with usage help. */
export class UsageError extends Error {
  /**
   * @param message What to fix.
   * @param title A short name for the problem.
   */
  constructor(
    message: string,
    readonly title = 'Missing option',
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Options for {@link signIn}. */
export interface SignInOptions {
  apiKey?: string;
  email?: string;
  idToken?: string;
  store: ConfigStore;
  /** Asks the user for the password of `email`. */
  promptPassword: (email: string) => Promise<string>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * Returns a token source for the options. It uses, in order: a given ID
 * token, a saved refresh token, or a password sign-in that saves a new
 * refresh token. A saved refresh token that Firebase rejects is deleted.
 * @param opts See {@link SignInOptions}.
 */
export async function signIn(opts: SignInOptions): Promise<TokenSource> {
  if (opts.idToken) return new StaticTokenSource(opts.idToken, opts.now);
  const { store } = opts;
  const apiKey = opts.apiKey;
  if (!apiKey) {
    throw new UsageError(
      'Pass --api-key (or set FIREBASE_API_KEY) to sign in, or set FIREBASE_ID_TOKEN.',
    );
  }
  const scope = authScope(apiKey, opts.env);
  const http = { apiKey, fetch: opts.fetch, env: opts.env };
  const persist = (user: AuthUser & { email: string }) => (token: string) =>
    store.saveCredential(scope, { ...user, refreshToken: token });

  let email = opts.email;
  const saved = await store.getCredential(scope, email);
  if (saved) {
    email = saved.email;
    const user = { uid: saved.uid, email: saved.email };
    const source = new RefreshingTokenSource({
      ...http,
      user,
      refreshToken: saved.refreshToken,
      now: opts.now,
      onRefreshToken: persist(user),
    });
    try {
      await source.getIdToken();
      await store.setLastEmail(scope, saved.email);
      return source;
    } catch (err) {
      if (!(err instanceof AuthError && DEAD_REFRESH_TOKEN.has(err.code)))
        throw err;
      await store.deleteCredential(scope, saved.email);
    }
  }
  if (!email) {
    throw new UsageError('Pass --email to sign in, or set FIREBASE_ID_TOKEN.');
  }
  const password = await opts.promptPassword(email);
  const grant = await signInWithPassword({ ...http, email, password });
  const user = { uid: grant.uid, email };
  await store.saveCredential(scope, {
    ...user,
    refreshToken: grant.refreshToken,
  });
  const now = opts.now ?? Date.now;
  return new RefreshingTokenSource({
    ...http,
    user,
    refreshToken: grant.refreshToken,
    idToken: grant.idToken,
    expiresAt: now() + grant.expiresIn * 1000,
    now: opts.now,
    onRefreshToken: persist(user),
  });
}
