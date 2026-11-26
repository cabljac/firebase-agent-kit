import {
  type AgentStreamChunk,
  type AgentTransport,
  createAgentAPI,
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
