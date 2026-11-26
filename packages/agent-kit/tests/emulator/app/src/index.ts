export * from '@cabljac/firebase-agent-kit';

import { ai, z } from '@cabljac/firebase-agent-kit';

const ToolOutputSchema = z.object({
  tool: z.string(),
  uid: z.string(),
});

for (const name of ['lookupOrder', 'quotePrice', 'userTool']) {
  ai.defineTool(
    {
      name,
      description: `Test tool ${name}.`,
      inputSchema: z.object({}),
      outputSchema: ToolOutputSchema,
    },
    async (_input, { context }) => ({ tool: name, uid: context.auth.uid }),
  );
}

ai.defineInterrupt({
  name: 'approveRefund',
  description: 'Ask the user to approve a refund.',
  inputSchema: z.object({}),
  outputSchema: z.object({ approved: z.boolean() }),
});

const failedFlakyKeys = new Set<string>();

ai.defineModel({ name: 'test/scripted' }, async (request) => {
  const messages = request.messages;
  const last = messages[messages.length - 1];
  const reply = (text: string) => ({
    finishReason: 'stop' as const,
    message: { role: 'model' as const, content: [{ text }] },
  });

  const toolResponse = last?.content.find(
    (part) => part.toolResponse,
  )?.toolResponse;
  if (toolResponse) {
    return reply(`tool result: ${JSON.stringify(toolResponse.output)}`);
  }

  const text = last?.content.map((part) => part.text ?? '').join('') ?? '';
  if (text.startsWith('wait ')) {
    const ms = Number(text.slice('wait '.length));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return reply(`waited ${ms}`);
  }
  if (text === 'prompt') {
    const system = messages.find((m) => m.role === 'system');
    return reply(
      system?.content
        .map((part) => part.text ?? '')
        .join('')
        .trim() ?? '',
    );
  }
  if (text === 'count') {
    const users = messages.filter((m) => m.role === 'user').length;
    return reply(`user messages: ${users}`);
  }
  if (text === 'tools') {
    return reply(
      (request.tools ?? [])
        .map((tool) => tool.name)
        .sort()
        .join(','),
    );
  }
  if (text.startsWith('flaky ')) {
    const key = text.slice('flaky '.length);
    if (!failedFlakyKeys.has(key)) {
      failedFlakyKeys.add(key);
      throw new Error(`flaky ${key} failed`);
    }
    return reply(`flaky ${key} recovered`);
  }
  if (text.startsWith('call ')) {
    const [name = '', ...input] = text.slice('call '.length).split(' ');
    return {
      finishReason: 'stop' as const,
      message: {
        role: 'model' as const,
        content: [
          {
            toolRequest: {
              name,
              ref: 'call-1',
              input: input.length > 0 ? JSON.parse(input.join(' ')) : {},
            },
          },
        ],
      },
    };
  }
  return reply('unknown command');
});
