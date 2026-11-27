import { expect, test } from 'vitest';
import {
  historyEntries,
  isRestartableApproval,
  pendingInterrupts,
  respondPart,
  restartPart,
  resumePayload,
} from '../../src/chat.js';
import {
  answerError,
  approvalDetails,
  describeAnswer,
  describeDetached,
  describeUrl,
  formatJson,
  helpLines,
  parseCommand,
  parseJsonInput,
  tailPreview,
} from '../../src/format.js';

test('parseCommand reads known commands; anything else is a message', () => {
  expect(parseCommand('hello /new')).toEqual({
    name: 'message',
    text: 'hello /new',
  });
  expect(parseCommand(' /new ')).toEqual({ name: 'new' });
  expect(parseCommand('/resume abc-123')).toEqual({
    name: 'resume',
    sessionId: 'abc-123',
  });
  expect(parseCommand('/resume')).toMatchObject({ name: 'invalid' });
  expect(parseCommand('/exit')).toEqual({ name: 'quit' });
  expect(parseCommand('/etc/hosts is a file')).toEqual({
    name: 'message',
    text: '/etc/hosts is a file',
  });
  expect(parseCommand('//new')).toEqual({ name: 'message', text: '/new' });
});

test('tailPreview keeps the end of a long line', () => {
  expect(tailPreview('short', 40, 3)).toBe('short');
  const long = 'x'.repeat(500);
  const preview = tailPreview(long, 40, 3);
  expect(preview.startsWith('…')).toBe(true);
  expect(preview.length).toBeLessThanOrEqual(60);
});

test('describeUrl names the function, which is the kit instance id', () => {
  expect(
    describeUrl('https://us-central1-p.cloudfunctions.net/kit-support-agent'),
  ).toEqual({
    host: 'us-central1-p.cloudfunctions.net',
    name: 'kit-support-agent',
  });
  expect(describeUrl('https://agent-abc-uc.a.run.app')).toEqual({
    host: 'agent-abc-uc.a.run.app',
    name: 'agent-abc-uc.a.run.app',
  });
  expect(describeUrl('not a url')).toEqual({
    host: 'not a url',
    name: 'not a url',
  });
});

test('formatJson pretty-prints and cuts long output', () => {
  expect(formatJson({ amount: 5 })).toBe('{\n  "amount": 5\n}');
  const long = formatJson(
    Array.from({ length: 30 }, (_, i) => i),
    5,
  );
  expect(long.split('\n')).toHaveLength(6);
  expect(long).toMatch(/\.\.\. 27 more lines$/);
});

test('parseJsonInput validates JSON', () => {
  expect(parseJsonInput('{"approved": true}')).toEqual({
    ok: true,
    value: { approved: true },
  });
  expect(parseJsonInput('  ')).toEqual({
    ok: false,
    error: 'Type a JSON value.',
  });
  expect(parseJsonInput('{bad')).toMatchObject({ ok: false });
  expect(parseJsonInput('"text"')).toEqual({ ok: true, value: 'text' });
});

test('describeAnswer names approvals and denials', () => {
  expect(describeAnswer('t', { approved: true })).toEqual({
    approved: true,
    text: 'Approved t',
  });
  expect(describeAnswer('t', { approved: false }).text).toBe('Denied t');
  expect(describeAnswer('t', { note: 'x' })).toEqual({
    text: 'Answered t with {"note":"x"}',
  });
});

test('helpLines aligns the commands', () => {
  const lines = helpLines();
  expect(lines[0]).toBe('/new               Start a new session');
  expect(lines).toContain(
    '/detach <message>  Run a turn in the background and wait for it',
  );
  expect(lines).toContain(
    '/quit, /exit       Exit (or press Ctrl+C at the prompt)',
  );
  expect(lines.at(-1)).toBe(
    'Ctrl+C             Stop a running reply, or stop waiting for a detached turn',
  );
});

test('parseCommand reads /detach with its message', () => {
  expect(parseCommand('/detach write a report')).toEqual({
    name: 'detach',
    text: 'write a report',
  });
  expect(parseCommand('/detach')).toEqual({
    name: 'invalid',
    message: 'Usage: /detach <message>',
  });
});

test('describeDetached explains each outcome', () => {
  const at = (status: 'completed' | 'failed' | 'aborted' | 'expired') =>
    describeDetached({ snapshotId: 'x', status, detail: 'why' });
  expect(at('completed')).toEqual({
    tone: 'success',
    text: 'Detached turn completed.',
  });
  expect(at('aborted')).toEqual({
    tone: 'warning',
    text: 'Detached turn aborted. why',
  });
  expect(at('failed').text).toBe('Detached turn failed. why');
  expect(at('expired').text).toMatch(/stopped. Send a message/);
});

const interruptPart = (name: string, ref: string, input: unknown) => ({
  toolRequest: { name, ref, input },
  metadata: { interrupt: true },
});

test('historyEntries merges the model messages of a turn', () => {
  expect(
    historyEntries([
      { role: 'system', content: [{ text: 'sys' }] },
      { role: 'user', content: [{ text: 'hi' }] },
      {
        role: 'model',
        content: [
          { toolRequest: { name: 'getMyProfile', input: {} } },
          interruptPart('approveTransfer', 'r1', { amount: 1 }),
        ],
      },
      {
        role: 'tool',
        content: [{ toolResponse: { name: 'getMyProfile', output: {} } }],
      },
      { role: 'model', content: [{ text: 'Hello ' }, { text: 'there' }] },
    ]),
  ).toEqual([
    { role: 'user', text: 'hi' },
    { role: 'agent', text: 'Hello there', tools: ['getMyProfile'] },
  ]);
});

test('pendingInterrupts reads interrupts from the last model message only', () => {
  const paused = {
    role: 'model' as const,
    content: [
      { text: 'Need approval' },
      interruptPart('approveTransfer', 'r1', { amount: 1 }),
    ],
  };
  expect(pendingInterrupts([paused])).toEqual([
    { name: 'approveTransfer', ref: 'r1', input: { amount: 1 } },
  ]);
  expect(pendingInterrupts([paused, { role: 'tool', content: [] }])).toEqual(
    [],
  );
  expect(pendingInterrupts([])).toEqual([]);
});

test('respondPart answers an interrupt by name and ref', () => {
  expect(
    respondPart({ name: 'approveTransfer', ref: 'r1', input: {} }, { ok: 1 }),
  ).toEqual({
    toolResponse: { name: 'approveTransfer', ref: 'r1', output: { ok: 1 } },
  });
  expect(respondPart({ name: 'x', input: {} }, 1)).toEqual({
    toolResponse: { name: 'x', output: 1 },
  });
});

const approval = {
  name: 'deleteFile',
  ref: 'd1',
  input: { path: '/tmp/x' },
  metadata: { kind: 'approval', action: 'delete /tmp/x' },
};
const question = {
  name: 'pickColor',
  ref: 'q1',
  input: {},
  metadata: { kind: 'question' },
};

test('pendingInterrupts keeps the interrupt metadata only when it is an object', () => {
  expect(
    pendingInterrupts([
      {
        role: 'model',
        content: [
          {
            toolRequest: { name: 'deleteFile', ref: 'd1', input: {} },
            metadata: { interrupt: { kind: 'approval' } },
          },
          interruptPart('approveTransfer', 'r1', {}),
        ],
      },
    ]),
  ).toEqual([
    {
      name: 'deleteFile',
      ref: 'd1',
      input: {},
      metadata: { kind: 'approval' },
    },
    { name: 'approveTransfer', ref: 'r1', input: {} },
  ]);
});

test('isRestartableApproval needs kind approval in the interrupt metadata', () => {
  expect(isRestartableApproval(approval)).toBe(true);
  expect(isRestartableApproval(question)).toBe(false);
  expect(isRestartableApproval({ name: 'x', input: {} })).toBe(false);
});

test('restartPart re-issues the tool request unchanged, with resumed metadata', () => {
  expect(restartPart(approval, { approved: true })).toEqual({
    toolRequest: { name: 'deleteFile', ref: 'd1', input: { path: '/tmp/x' } },
    metadata: { resumed: { approved: true } },
  });
  expect(restartPart({ name: 'x', input: 1 }, { approved: false })).toEqual({
    toolRequest: { name: 'x', input: 1 },
    metadata: { resumed: { approved: false } },
  });
});

test('resumePayload restarts approvals and responds to every other interrupt', () => {
  expect(
    resumePayload([
      { interrupt: approval, output: { approved: false } },
      { interrupt: question, output: 'red' },
      {
        interrupt: { name: 'approveTransfer', input: {} },
        output: { approved: true },
      },
    ]),
  ).toEqual({
    restart: [restartPart(approval, { approved: false })],
    respond: [
      respondPart(question, 'red'),
      respondPart({ name: 'approveTransfer', input: {} }, { approved: true }),
    ],
  });
  expect(
    resumePayload([{ interrupt: approval, output: { approved: true } }]),
  ).toEqual({ restart: [restartPart(approval, { approved: true })] });
});

test('resumePayload refuses an approval answer that is not an object', () => {
  expect(() => resumePayload([{ interrupt: approval, output: true }])).toThrow(
    'The answer to the approval deleteFile must be a JSON object.',
  );
});

test('answerError asks for an object only for restartable approvals', () => {
  expect(answerError(approval, { approved: false, reason: 'no' })).toBe(
    undefined,
  );
  expect(answerError(approval, true)).toMatch(/takes a JSON object/);
  expect(answerError(approval, [1])).toMatch(/takes a JSON object/);
  expect(answerError(approval, null)).toMatch(/takes a JSON object/);
  expect(answerError(question, 'red')).toBe(undefined);
});

test('approvalDetails shows the approval metadata without kind', () => {
  expect(approvalDetails(approval)).toEqual({ action: 'delete /tmp/x' });
  expect(approvalDetails({ ...approval, metadata: { kind: 'approval' } })).toBe(
    undefined,
  );
  expect(approvalDetails(question)).toBe(undefined);
});
