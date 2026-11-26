import { AgentError, createAgentAPI } from 'genkit/beta/client';
import { expect, test } from 'vitest';
import { AUTH_NETWORK_ERROR, AuthError, UsageError } from '../../src/auth.js';
import { SessionLoadError } from '../../src/chat.js';
import { explain, parseServerError } from '../../src/errors.js';
import { problemLines } from '../../src/plain.js';
import { ConfigFileError } from '../../src/store.js';

const server = (status: number, body: unknown) =>
  new Error(
    `Server returned: ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
  );

test('parseServerError reads the status and the JSON message', () => {
  expect(
    parseServerError(
      'Server returned: 409: {"status":"ABORTED","message":"busy"}',
    ),
  ).toEqual({ httpStatus: 409, status: 'ABORTED', message: 'busy' });
  expect(parseServerError('Server returned: 502: Bad Gateway\n')).toEqual({
    httpStatus: 502,
    message: 'Bad Gateway',
  });
  expect(
    parseServerError('Server returned: 404: <html><h1>Not Found</h1></html>'),
  ).toEqual({ httpStatus: 404, message: '' });
  expect(parseServerError('other')).toBeUndefined();
});

test.each([
  [409, { status: 'ABORTED', message: 'Another turn' }, 'busy'],
  [401, { status: 'UNAUTHENTICATED', message: 'x' }, 'unauthenticated'],
  [403, { status: 'PERMISSION_DENIED', message: 'x' }, 'forbidden'],
  [400, { status: 'FAILED_PRECONDITION', message: 'bad prompt' }, 'config'],
  [400, { status: 'INVALID_ARGUMENT', message: 'x' }, 'unknown'],
  [404, 'Not Found', 'not-found'],
  [500, { status: 'INTERNAL', message: 'Internal Error' }, 'unknown'],
])('explains HTTP %i as %s', (status, body, kind) => {
  expect(explain(server(status, body)).kind).toBe(kind);
});

test('shows the server message for a kit config error', () => {
  expect(
    explain(
      server(400, {
        status: 'FAILED_PRECONDITION',
        message:
          'Agent kit instance "support" lists tools that are not defined',
      }),
    ),
  ).toMatchObject({
    title: 'The agent is misconfigured',
    detail: 'Agent kit instance "support" lists tools that are not defined',
  });
});

test('explains network failures', () => {
  const err = new TypeError('fetch failed', {
    cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
  });
  expect(explain(err).kind).toBe('network');
});

test('explains sign-in errors without echoing secrets', () => {
  const problem = explain(new AuthError('INVALID_LOGIN_CREDENTIALS', 'x'));
  expect(problem).toMatchObject({
    kind: 'sign-in',
    detail: 'The email or password is wrong.',
  });
  expect(explain(new UsageError('Pass --url')).kind).toBe('usage');
});

/** Runs a turn on a fake transport so the client throws a real AgentError. */
function failTurn(fail: () => never | { status: string; message: string }) {
  const api = createAgentAPI({
    runTurn: () => ({
      stream: (async function* () {})(),
      output: (async () => {
        const error = fail();
        return { finishReason: 'failed' as const, error };
      })(),
    }),
    getSnapshot: async () => undefined,
    abort: async () => undefined,
  });
  return api
    .chat()
    .send('x')
    .catch((e: unknown) => e);
}

test('explains a failed turn with its status', async () => {
  const err = await failTurn(() => ({
    status: 'NOT_FOUND',
    message: 'Tool lookup not found',
  }));
  expect(err).toBeInstanceOf(AgentError);
  expect(explain(err)).toMatchObject({
    kind: 'turn-failed',
    detail: 'NOT_FOUND: Tool lookup not found',
  });
});

test('explains a session that cannot be loaded', () => {
  expect(
    explain(
      new SessionLoadError(
        's1',
        server(500, { status: 'INTERNAL', message: 'Internal Error' }),
      ),
    ),
  ).toMatchObject({
    kind: 'session-not-found',
    title: 'Could not load session s1',
  });
  expect(
    explain(new SessionLoadError('s1', server(401, { message: 'x' }))).kind,
  ).toBe('unauthenticated');
});

test('problemLines formats a problem as plain text', () => {
  expect(
    problemLines({ kind: 'busy', title: 'T', detail: 'D', hint: 'H' }),
  ).toEqual(['error: T', '  D', '  -> H']);
});

test('a token refresh that fails inside a turn blames Firebase Auth, not the agent URL', async () => {
  const err = await failTurn(() => {
    throw new AuthError(AUTH_NETWORK_ERROR, 'Cannot reach Firebase Auth.', {
      cause: new TypeError('fetch failed'),
    });
  });
  expect(explain(err)).toMatchObject({
    kind: 'auth-network',
    title: 'Cannot reach Firebase Auth',
  });
  expect(explain(err).hint).not.toContain('URL');
});

test('advice for 401 and 403 depends on how the user signed in', () => {
  const forbidden = server(403, { message: 'x' });
  expect(explain(forbidden).hint).toContain('--logout');
  expect(explain(forbidden, { staticToken: true }).hint).not.toContain(
    '--logout',
  );
  expect(explain(forbidden, { staticToken: true }).hint).toContain(
    'FIREBASE_ID_TOKEN',
  );
  expect(
    explain(server(401, { message: 'x' }), { staticToken: true }).hint,
  ).not.toContain('--logout');
});

test('names the damaged config file', () => {
  expect(
    explain(new ConfigFileError('/c/credentials.json', 'is not valid JSON.')),
  ).toMatchObject({
    kind: 'config-file',
    detail: '/c/credentials.json is not valid JSON.',
  });
});

test('usage errors keep their own title', () => {
  expect(explain(new UsageError('x', 'No saved sign-in')).title).toBe(
    'No saved sign-in',
  );
});
