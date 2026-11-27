import {
  createUserScopedStore,
  onAgentRequest,
} from '@cabljac/firebase-agent-kit-core';
import { initializeApp } from 'firebase-admin/app';
import { genkit, z } from 'genkit/beta';

initializeApp();

const ai = genkit({});

const approveTransfer = ai.defineInterrupt({
  name: 'approveTransfer',
  description: 'Ask the user to approve a money transfer.',
  inputSchema: z.object({ amount: z.number() }),
  outputSchema: z.object({ approved: z.boolean() }),
});

ai.defineModel({ name: 'test/scripted' }, async (request, sendChunk) => {
  const messages = request.messages;
  const last = messages[messages.length - 1];
  const reply = (text: string) => ({
    finishReason: 'stop' as const,
    message: { role: 'model' as const, content: [{ text }] },
  });

  const toolResponse = last?.content.find((part) => part.toolResponse);
  if (toolResponse?.toolResponse) {
    return reply(
      `transfer result: ${JSON.stringify(toolResponse.toolResponse.output)}`,
    );
  }

  const text = last?.content.map((part) => part.text ?? '').join('') ?? '';
  const slow = /^slow (\d+)$/.exec(text);
  if (slow) {
    await new Promise((resolve) => setTimeout(resolve, Number(slow[1])));
    return reply('slept');
  }
  if (text.includes('transfer')) {
    return {
      finishReason: 'stop' as const,
      message: {
        role: 'model' as const,
        content: [
          {
            toolRequest: {
              name: 'approveTransfer',
              ref: 'transfer-1',
              input: { amount: 500 },
            },
          },
        ],
      },
    };
  }
  if (text === 'count') {
    const users = messages.filter((m) => m.role === 'user').length;
    return reply(`user messages: ${users}`);
  }
  if (text.startsWith('echo ')) return reply(text.slice('echo '.length));
  if (text.startsWith('stream ')) {
    const words = text.slice('stream '.length).split(' ');
    for (const [i, word] of words.entries()) {
      sendChunk?.({ content: [{ text: i ? ` ${word}` : word }] });
    }
    return reply(words.join(' '));
  }
  return reply('unknown command');
});

const agent = ai.defineAgent({
  name: 'testAgent',
  model: 'test/scripted',
  tools: [approveTransfer],
  store: createUserScopedStore(),
  system: 'You are a deterministic test agent.',
});

export const testAgent = onAgentRequest(agent, {
  httpsOptions: { timeoutSeconds: 60 },
});

const scopedAgent = (scope: string) =>
  onAgentRequest(
    ai.defineAgent({
      name: `${scope}Agent`,
      model: 'test/scripted',
      store: createUserScopedStore({ scope }),
    }),
  );

export const alphaAgent = scopedAgent('alpha');
export const betaAgent = scopedAgent('beta');

const deleteFile = ai.defineTool(
  {
    name: 'deleteFile',
    description: 'Delete a file after the user approves.',
    inputSchema: z.object({ path: z.string() }),
    outputSchema: z.object({
      deleted: z.string().optional(),
      declined: z.boolean().optional(),
    }),
  },
  async ({ path }, { interrupt, resumed }) => {
    if (!resumed) interrupt({ kind: 'approval', action: `delete ${path}` });
    if (typeof resumed === 'object' && resumed.approved === true) {
      return { deleted: path };
    }
    return { declined: true };
  },
);

const pickColor = ai.defineInterrupt({
  name: 'pickColor',
  description: 'Ask the user to pick a colour.',
  inputSchema: z.object({}),
  outputSchema: z.string(),
  requestMetadata: { kind: 'question' },
});

ai.defineModel({ name: 'test/approvals' }, async (request) => {
  const last = request.messages[request.messages.length - 1];
  const responses = last?.content.flatMap((part) =>
    part.toolResponse ? [part.toolResponse] : [],
  );
  if (responses?.length) {
    const outputs = Object.fromEntries(
      responses.map((r) => [r.name, r.output]),
    );
    return {
      finishReason: 'stop' as const,
      message: {
        role: 'model' as const,
        content: [{ text: `results: ${JSON.stringify(outputs)}` }],
      },
    };
  }
  const text = last?.content.map((part) => part.text ?? '').join('') ?? '';
  const requests = [
    ...(/delete|both/.test(text)
      ? [{ name: 'deleteFile', ref: 'del-1', input: { path: '/tmp/x' } }]
      : []),
    ...(/ask|both/.test(text)
      ? [{ name: 'pickColor', ref: 'ask-1', input: {} }]
      : []),
  ];
  return {
    finishReason: 'stop' as const,
    message: {
      role: 'model' as const,
      content: requests.map((toolRequest) => ({ toolRequest })),
    },
  };
});

export const approvalAgent = onAgentRequest(
  ai.defineAgent({
    name: 'approvalAgent',
    model: 'test/approvals',
    tools: [deleteFile, pickColor],
    store: createUserScopedStore({ scope: 'approval' }),
  }),
  { httpsOptions: { timeoutSeconds: 60 } },
);
