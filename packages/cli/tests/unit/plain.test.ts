import { PassThrough, Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { runPlain } from '../../src/plain.js';
import { done, FakeSession, interrupted, type Script } from './fake-session.js';

async function runLines(
  session: FakeSession,
  lines: string[],
  resume?: string,
) {
  const output = new PassThrough();
  const errors = new PassThrough();
  let out = '';
  let err = '';
  output.on('data', (d) => {
    out += d;
  });
  errors.on('data', (d) => {
    err += d;
  });
  const code = await runPlain({
    core: session,
    agentName: 'agent',
    user: 'u',
    input: Readable.from(lines.map((l) => `${l}\n`)),
    output,
    errors,
    resume,
  });
  return { code, out, err };
}

const replyOrInterrupt: Script = async (input) =>
  'message' in input ? interrupted : done('ok');

test('prints the reply and exits 0', async () => {
  const session = new FakeSession(async () => done('hello back'));
  const { code, out, err } = await runLines(session, ['hello']);
  expect(code).toBe(0);
  expect(out).toContain('agent> hello back');
  expect(out).toContain('session: s1');
  expect(err).toBe('');
});

test.each([
  ['approve', { approved: true }],
  ['deny', { approved: false }],
  ['{"note":"x"}', { note: 'x' }],
])('answers an interrupt with %s', async (answer, output) => {
  const session = new FakeSession(replyOrInterrupt);
  const { out } = await runLines(session, ['pay', answer]);
  expect(out).toContain('approval needed: approveTransfer');
  expect(session.turns[1]).toEqual({
    respond: [
      {
        interrupt: { name: 'approveTransfer', ref: 'r1', input: { amount: 5 } },
        output,
      },
    ],
  });
});

test('rejects an answer that is not JSON and keeps waiting', async () => {
  const session = new FakeSession(replyOrInterrupt);
  const { err } = await runLines(session, ['pay', 'yes please', 'approve']);
  expect(err).toContain('Not valid JSON');
  expect(session.turns).toHaveLength(2);
});

test('writes a failed turn to stderr and exits 1', async () => {
  const session = new FakeSession(async () => {
    throw new Error('Server returned: 403: {"message":"no"}');
  });
  const { code, out, err } = await runLines(session, ['hello']);
  expect(code).toBe(1);
  expect(err).toContain('error: Access denied');
  expect(out).not.toContain('error:');
});

test('retry reloads the session and sends the input again after a 409', async () => {
  let calls = 0;
  const session = new FakeSession(async () => {
    calls++;
    if (calls === 1) throw new Error('Server returned: 409: {}');
    return done('second');
  });
  const { out, err } = await runLines(session, ['hi', 'retry']);
  expect(err).toContain('Type retry');
  expect(session.reloads).toBe(1);
  expect(session.turns).toEqual([{ message: 'hi' }, { message: 'hi' }]);
  expect(out).toContain('agent> second');
});

test('prints the history of a resumed session', async () => {
  const session = new FakeSession(
    async () => done(''),
    async () => ({
      history: [
        { role: 'user', text: 'earlier' },
        { role: 'agent', text: 'reply', tools: [] },
      ],
      pending: [],
    }),
  );
  const { out } = await runLines(session, ['/quit'], 'old');
  expect(out).toContain('resumed session old');
  expect(out).toContain('you> earlier');
  expect(out).toContain('agent> reply');
});
