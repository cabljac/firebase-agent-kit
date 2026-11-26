import { initializeApp } from 'firebase-admin/app';
import { genkit, z } from 'genkit/beta';
import { createUserScopedStore, onAgentRequest } from 'genkit-agent-functions';

initializeApp();

const ai = genkit({});

const approveTransfer = ai.defineInterrupt({
  name: 'approveTransfer',
  description: 'Ask the user to approve a money transfer.',
  inputSchema: z.object({ amount: z.number() }),
  outputSchema: z.object({ approved: z.boolean() }),
});

ai.defineModel({ name: 'test/scripted' }, async (request) => {
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
