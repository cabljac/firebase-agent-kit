import {
  type AgentInput,
  type AgentStreamChunk,
  type AgentTransport,
  createAgentAPI,
  type SessionSnapshot,
} from 'genkit/beta/client';
import { expect, test } from 'vitest';
import { StaticTokenSource } from '../../src/auth.js';
import { ChatCore } from '../../src/chat.js';

const tokens = new StaticTokenSource(
  `h.${Buffer.from(JSON.stringify({ user_id: 'u' })).toString('base64url')}.s`,
);

/** A transport that streams `chunks`, then finishes with `output`. */
function transport(
  chunks: AgentStreamChunk[],
  output: Awaited<ReturnType<AgentTransport['runTurn']>['output']>,
): AgentTransport {
  return {
    runTurn: () => ({
      stream: (async function* () {
        yield* chunks;
      })(),
      output: Promise.resolve(output),
    }),
    getSnapshot: async () => undefined,
    abort: async () => undefined,
  };
}

const core = (t: AgentTransport) =>
  new ChatCore({ url: 'http://x', tokens, agent: createAgentAPI(t) });

test('joins the text of separate model messages with a blank line', async () => {
  const chat = core(
    transport(
      [
        {
          modelChunk: { role: 'model', index: 0, content: [{ text: 'first' }] },
        },
        {
          modelChunk: {
            role: 'model',
            index: 1,
            content: [{ text: 'second' }],
          },
        },
      ],
      { finishReason: 'stop', sessionId: 's1' },
    ),
  );
  const texts: string[] = [];
  const outcome = await chat.runTurn(
    { message: 'hi' },
    { onText: (t) => texts.push(t) },
  );
  expect(outcome).toMatchObject({ status: 'done', text: 'first\n\nsecond' });
  expect(texts).toEqual(['first', 'first\n\nsecond']);
  expect(chat.sessionId).toBe('s1');
});

test('counts tool calls from model chunks only, and leaves out interrupts', async () => {
  const request = { toolRequest: { name: 'approve', input: {} } };
  const chat = core(
    transport(
      [
        {
          modelChunk: {
            role: 'model',
            index: 0,
            content: [{ toolRequest: { name: 'lookup', input: {} } }],
          },
        },
        { modelChunk: { role: 'model', index: 0, content: [request] } },
        {
          modelChunk: {
            role: 'tool',
            content: [{ ...request, metadata: { interrupt: true } }],
          },
        },
      ],
      {
        finishReason: 'interrupted',
        message: {
          role: 'model',
          content: [{ ...request, metadata: { interrupt: true } }],
        },
      },
    ),
  );
  const called: string[] = [];
  const outcome = await chat.runTurn(
    { message: 'pay' },
    { onToolCall: (n) => called.push(n) },
  );
  expect(called).toEqual(['lookup', 'approve']);
  expect(outcome).toMatchObject({
    status: 'interrupted',
    tools: ['lookup'],
    interrupts: [{ name: 'approve', input: {} }],
  });
});

test('reads interrupt metadata and resumes with restart and respond together', async () => {
  const approval = {
    toolRequest: { name: 'deleteFile', ref: 'd1', input: { path: '/x' } },
    metadata: { interrupt: { kind: 'approval', action: 'delete /x' } },
  };
  const plain = {
    toolRequest: { name: 'approveTransfer', ref: 't1', input: {} },
    metadata: { interrupt: true },
  };
  const inputs: AgentInput[] = [];
  const outputs: Awaited<ReturnType<AgentTransport['runTurn']>['output']>[] = [
    {
      finishReason: 'interrupted',
      sessionId: 's1',
      message: { role: 'model', content: [approval, plain] },
    },
    { finishReason: 'stop', sessionId: 's1' },
  ];
  const chat = core({
    runTurn: (input) => {
      inputs.push(input);
      const output = outputs[inputs.length - 1];
      if (!output) throw new Error('unexpected turn');
      return {
        stream: (async function* () {})(),
        output: Promise.resolve(output),
      };
    },
    getSnapshot: async () => undefined,
    abort: async () => undefined,
  });
  const paused = await chat.runTurn({ message: 'clean up' });
  if (paused.status !== 'interrupted') throw new Error('not interrupted');
  const [deleteFile, transfer] = paused.interrupts;
  expect(paused.interrupts).toEqual([
    {
      name: 'deleteFile',
      ref: 'd1',
      input: { path: '/x' },
      metadata: { kind: 'approval', action: 'delete /x' },
    },
    { name: 'approveTransfer', ref: 't1', input: {} },
  ]);
  if (!deleteFile || !transfer) throw new Error('missing interrupts');

  await chat.runTurn({
    answers: [
      { interrupt: deleteFile, output: { approved: true } },
      { interrupt: transfer, output: { approved: false } },
    ],
  });
  expect(inputs[1]?.resume).toEqual({
    restart: [
      {
        toolRequest: { name: 'deleteFile', ref: 'd1', input: { path: '/x' } },
        metadata: { resumed: { approved: true } },
      },
    ],
    respond: [
      {
        toolResponse: {
          name: 'approveTransfer',
          ref: 't1',
          output: { approved: false },
        },
      },
    ],
  });
});

/** A server holding `snapshots`, whose detached turns land as `settled`. */
function detachServer(
  snapshots: Record<string, SessionSnapshot>,
  settled?: SessionSnapshot,
) {
  const inputs: AgentInput[] = [];
  const inits: unknown[] = [];
  const t: AgentTransport = {
    runTurn: (input, init) => {
      inputs.push(input);
      inits.push(init);
      return {
        stream: (async function* () {})(),
        output: Promise.resolve(
          input.detach
            ? { sessionId: 's1', snapshotId: 'd1', finishReason: 'detached' }
            : { sessionId: 's1', snapshotId: 'n1', finishReason: 'stop' },
        ),
      };
    },
    getSnapshot: async (lookup) =>
      'sessionId' in lookup ? snapshots.tip : snapshots[lookup.snapshotId],
    waitForSnapshot: async (snapshotId) => settled ?? snapshots[snapshotId],
    abort: async () => undefined,
  };
  return { t, inputs, inits };
}

const snap = (over: Partial<SessionSnapshot>): SessionSnapshot => ({
  snapshotId: 'x',
  sessionId: 's1',
  createdAt: '2026-11-26T00:00:00Z',
  ...over,
});

const said = (user: string, model: string) => ({
  sessionId: 's1',
  messages: [
    { role: 'user' as const, content: [{ text: user }] },
    { role: 'model' as const, content: [{ text: model }] },
  ],
});

test('detach sends detach: true, reports the snapshot, and returns the settled reply', async () => {
  const completed = snap({
    snapshotId: 'd1',
    status: 'completed',
    state: said('job', 'job done'),
  });
  const { t, inputs, inits } = detachServer({ tip: completed, d1: completed });
  const chat = core(t);
  const started: string[] = [];
  const outcome = await chat.detach('job', {
    onDetached: (id) => started.push(id),
  });
  expect(inputs[0]).toMatchObject({ detach: true });
  expect(started).toEqual(['d1']);
  expect(outcome).toEqual({
    snapshotId: 'd1',
    status: 'completed',
    text: 'job done',
  });
  expect(chat.sessionId).toBe('s1');
  await chat.runTurn({ message: 'next' });
  expect(inits.at(-1)).toEqual({ snapshotId: 'd1' });
});

test('waitDetached reports an aborted turn with its error', async () => {
  const aborted = snap({
    snapshotId: 'd1',
    status: 'aborted',
    error: { status: 'ABORTED', message: 'stopped' },
    state: said('job', 'partial'),
  });
  const { t } = detachServer({ tip: aborted, d1: aborted });
  const outcome = await core(t).waitDetached('d1');
  expect(outcome).toEqual({
    snapshotId: 'd1',
    status: 'aborted',
    text: '',
    detail: 'stopped',
  });
});

test('loadSession reports a running detached turn and shows the history before it', async () => {
  const { t } = detachServer({
    tip: snap({ snapshotId: 'd1', status: 'pending', parentId: 'p1' }),
    d1: snap({ snapshotId: 'd1', status: 'pending', parentId: 'p1' }),
    p1: snap({ snapshotId: 'p1', state: said('earlier', 'reply') }),
  });
  const loaded = await core(t).loadSession('s1');
  expect(loaded.running).toBe('d1');
  expect(loaded.history).toEqual([
    { role: 'user', text: 'earlier' },
    { role: 'agent', text: 'reply', tools: [] },
  ]);
});

test('loadSession reports a detached turn whose worker stopped', async () => {
  const dead = snap({ snapshotId: 'd1', status: 'expired', parentId: 'p1' });
  const { t } = detachServer({
    tip: dead,
    d1: dead,
    p1: snap({ snapshotId: 'p1', state: said('earlier', 'reply') }),
  });
  const loaded = await core(t).loadSession('s1');
  expect(loaded.expired).toBe('d1');
  expect(loaded.running).toBeUndefined();
  expect(loaded.history).toHaveLength(2);
});

const endsOnInterrupt = {
  sessionId: 's1',
  messages: [
    { role: 'user' as const, content: [{ text: 'clean up' }] },
    {
      role: 'model' as const,
      content: [
        {
          toolRequest: { name: 'deleteFile', ref: 'r1', input: {} },
          metadata: { interrupt: { kind: 'approval' } },
        },
      ],
    },
  ],
};

test.each(['aborted', 'failed'] as const)(
  'waitDetached reports a %s turn that ended on an interrupt as it is, with no interrupts',
  async (status) => {
    const stopped = snap({
      snapshotId: 'd1',
      status,
      finishReason: 'interrupted',
      error: { status: 'ABORTED', message: 'stopped' },
      state: endsOnInterrupt,
    });
    const { t } = detachServer({ tip: stopped, d1: stopped });
    const outcome = await core(t).waitDetached('d1');
    expect(outcome).toEqual({
      snapshotId: 'd1',
      status,
      text: '',
      detail: 'stopped',
    });
  },
);

test('waitDetached warns when an interrupted turn has no interrupt it can read', async () => {
  const paused = snap({
    snapshotId: 'd1',
    status: 'completed',
    finishReason: 'interrupted',
    state: said('clean up', 'asking'),
  });
  const { t } = detachServer({ tip: paused, d1: paused });
  const outcome = await core(t).waitDetached('d1');
  expect(outcome).toEqual({
    snapshotId: 'd1',
    status: 'unreadable-interrupt',
    text: 'asking',
  });
});

test('detach returns the interrupts of a turn that settled on one, and the answer resumes it', async () => {
  const paused = snap({
    snapshotId: 'd1',
    status: 'completed',
    finishReason: 'interrupted',
    state: {
      sessionId: 's1',
      messages: [
        { role: 'user', content: [{ text: 'clean up' }] },
        {
          role: 'model',
          content: [
            { text: 'asking' },
            {
              toolRequest: { name: 'deleteFile', ref: 'r1', input: { p: 1 } },
              metadata: { interrupt: { kind: 'approval', action: 'del' } },
            },
          ],
        },
      ],
    },
  });
  const { t, inputs, inits } = detachServer({ tip: paused, d1: paused });
  const chat = core(t);
  const outcome = await chat.detach('clean up');
  const interrupt = {
    name: 'deleteFile',
    ref: 'r1',
    input: { p: 1 },
    metadata: { kind: 'approval', action: 'del' },
  };
  expect(outcome).toEqual({
    snapshotId: 'd1',
    status: 'interrupted',
    text: 'asking',
    interrupts: [interrupt],
  });
  await chat.runTurn({ answers: [{ interrupt, output: { approved: true } }] });
  expect(inits.at(-1)).toEqual({ snapshotId: 'd1' });
  expect(inputs.at(-1)?.resume).toEqual({
    restart: [
      {
        toolRequest: { name: 'deleteFile', ref: 'r1', input: { p: 1 } },
        metadata: { resumed: { approved: true } },
      },
    ],
  });
});
