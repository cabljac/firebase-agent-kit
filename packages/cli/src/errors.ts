import { AgentError } from 'genkit/beta/client';
import { AUTH_NETWORK_ERROR, AuthError, UsageError } from './auth.js';
import { SessionLoadError } from './chat.js';
import { ConfigFileError } from './store.js';

/** The kinds of failure the UI explains differently. */
export type ProblemKind =
  | 'busy'
  | 'unauthenticated'
  | 'forbidden'
  | 'config'
  | 'config-file'
  | 'not-found'
  | 'session-not-found'
  | 'network'
  | 'auth-network'
  | 'sign-in'
  | 'usage'
  | 'turn-failed'
  | 'unknown';

/** A failure, explained for the user. */
export interface Problem {
  kind: ProblemKind;
  title: string;
  /** What the server or library said, if it helps. */
  detail?: string;
  /** What the user can do next. */
  hint: string;
}

/** What `explain` needs to know to give the right advice. */
export interface ExplainContext {
  /** True when the ID token came from `FIREBASE_ID_TOKEN` or `--id-token`. */
  staticToken?: boolean;
}

const SIGN_IN_MESSAGES: Record<string, string> = {
  INVALID_LOGIN_CREDENTIALS: 'The email or password is wrong.',
  INVALID_PASSWORD: 'The email or password is wrong.',
  EMAIL_NOT_FOUND: 'The email or password is wrong.',
  USER_DISABLED: 'This account is disabled.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later.',
  INVALID_EMAIL: 'The email address is not valid.',
  OPERATION_NOT_ALLOWED:
    'Email/password sign-in is not enabled for this project.',
  INVALID_ID_TOKEN: 'The ID token is not valid.',
  ID_TOKEN_EXPIRED:
    'The ID token has expired. ID tokens last one hour and cannot be refreshed here.',
  'API key not valid. Please pass a valid API key.':
    'The API key is not valid for Firebase Auth.',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Splits a `Server returned: <status>: <body>` message from the Genkit client
 * into the HTTP status and the server's message. An HTML body is dropped.
 * @param message The error message.
 */
export function parseServerError(
  message: string,
): { httpStatus: number; status?: string; message: string } | undefined {
  const match = /^Server returned: (\d{3}): ([\s\S]*)$/.exec(message);
  if (!match) return undefined;
  const httpStatus = Number(match[1]);
  const body = match[2] ?? '';
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    const text = body.trim();
    return { httpStatus, message: text.startsWith('<') ? '' : text };
  }
  if (!isRecord(json)) return { httpStatus, message: body };
  return {
    httpStatus,
    status: typeof json.status === 'string' ? json.status : undefined,
    message: typeof json.message === 'string' ? json.message : body,
  };
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === 'fetch failed') return true;
  const cause = err.cause;
  const code =
    cause instanceof Error && 'code' in cause ? cause.code : undefined;
  return (
    code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET'
  );
}

/**
 * Explains an error from sign-in or from a turn.
 * @param err The thrown value.
 * @param ctx How the user signed in, to tailor the advice.
 */
export function explain(err: unknown, ctx: ExplainContext = {}): Problem {
  // A token refresh that fails inside a turn reaches us wrapped by the client.
  if (err instanceof AgentError && err.details instanceof AuthError)
    return explain(err.details, ctx);
  if (err instanceof UsageError) {
    return {
      kind: 'usage',
      title: err.title,
      detail: err.message,
      hint: 'Run genkit-agent-chat --help for all options.',
    };
  }
  if (err instanceof ConfigFileError) {
    return {
      kind: 'config-file',
      title: 'A config file is damaged',
      detail: err.message,
      hint: `Fix or delete ${err.path}, then run again. Deleting credentials.json signs you out.`,
    };
  }
  if (err instanceof AuthError) {
    if (err.code === AUTH_NETWORK_ERROR) {
      return {
        kind: 'auth-network',
        title: 'Cannot reach Firebase Auth',
        detail: err.cause instanceof Error ? err.cause.message : undefined,
        hint: 'Check your network connection. With the Auth emulator, check FIREBASE_AUTH_EMULATOR_HOST.',
      };
    }
    return {
      kind: 'sign-in',
      title: 'Sign-in failed',
      detail: SIGN_IN_MESSAGES[err.code] ?? `${err.code}: ${err.message}`,
      hint: ctx.staticToken
        ? 'Set a fresh FIREBASE_ID_TOKEN, or sign in with --email.'
        : 'Check the email, password and API key, then run again.',
    };
  }
  if (err instanceof SessionLoadError) {
    const cause = explain(err.cause, ctx);
    if (cause.kind !== 'unknown' && cause.kind !== 'session-not-found')
      return cause;
    return {
      kind: 'session-not-found',
      title: `Could not load session ${err.sessionId}`,
      detail: cause.detail,
      hint: 'Check the session id, or type /new to start a new session.',
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    isNetworkError(err) ||
    (err instanceof Error && isNetworkError(err.cause))
  )
    return {
      kind: 'network',
      title: 'Cannot reach the agent',
      detail: message,
      hint: 'Check the agent URL and your network connection, then try again.',
    };
  if (/^Snapshot (session )?\S+ not found\.$/.test(message)) {
    return {
      kind: 'session-not-found',
      title: 'Session not found',
      detail: message,
      hint: 'Check the session id, or type /new to start a new session.',
    };
  }
  const server = parseServerError(message);
  if (server) {
    const detail = server.message || undefined;
    switch (server.httpStatus) {
      case 409:
        return {
          kind: 'busy',
          title: 'Session busy',
          detail,
          hint: 'Wait for the other turn to finish, then reload the session and send again.',
        };
      case 401:
        return {
          kind: 'unauthenticated',
          title: 'Not signed in',
          detail,
          hint: ctx.staticToken
            ? 'The server got no valid ID token. Set a fresh FIREBASE_ID_TOKEN, or sign in with --email.'
            : 'The server got no valid ID token. Run again; if it repeats, run with --logout and sign in again.',
        };
      case 403:
        return {
          kind: 'forbidden',
          title: 'Access denied',
          detail,
          hint: ctx.staticToken
            ? 'The ID token was rejected, or the agent needs App Check. Set a fresh FIREBASE_ID_TOKEN, or sign in with --email.'
            : 'The ID token was rejected, or the agent needs App Check. Run with --logout, then sign in again.',
        };
      case 400:
        if (server.status === 'FAILED_PRECONDITION') {
          return {
            kind: 'config',
            title: 'The agent is misconfigured',
            detail,
            hint: 'Ask the agent owner to check the function logs and the instance prompt and tools.',
          };
        }
        break;
      case 404:
        return {
          kind: 'not-found',
          title: 'No agent at this URL',
          detail,
          hint: 'Check the agent URL, or the project, instance and region it was built from.',
        };
    }
    return {
      kind: 'unknown',
      title: `The server answered ${server.httpStatus}`,
      detail,
      hint: 'Try again. If it keeps failing, check the function logs.',
    };
  }
  if (err instanceof AgentError) {
    return {
      kind: 'turn-failed',
      title: 'The turn failed',
      detail: `${err.status}: ${message}`,
      hint: 'Send the message again, or type /new to start a new session.',
    };
  }
  return {
    kind: 'unknown',
    title: 'Something went wrong',
    detail: message,
    hint: 'Try again.',
  };
}
