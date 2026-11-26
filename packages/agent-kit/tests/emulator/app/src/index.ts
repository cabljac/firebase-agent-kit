export * from 'genkit-agent-kit';

import { defineKitModel, defineKitTool, z } from 'genkit-agent-kit';

const ToolOutputSchema = z.object({
  tool: z.string(),
  uid: z.string().nullable(),
});

for (const name of ['lookupOrder', 'quotePrice', 'userTool']) {
  defineKitTool(
    {
      name,
      description: `Test tool ${name}.`,
      inputSchema: z.object({}),
      outputSchema: ToolOutputSchema,
    },
    async (_input, { context }) => ({
      tool: name,
      uid: typeof context.auth?.uid === 'string' ? context.auth.uid : null,
    }),
  );
}

defineKitModel({ name: 'test/scripted' }, async (request) => {
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
  if (text === 'prompt') {
    const system = messages.find((m) => m.role === 'system');
    return reply(
      system?.content
        .map((part) => part.text ?? '')
        .join('')
        .trim() ?? '',
    );
  }
  if (text === 'tools') {
    return reply(
      (request.tools ?? [])
        .map((tool) => tool.name)
        .sort()
        .join(','),
    );
  }
  if (text.startsWith('call ')) {
    return {
      finishReason: 'stop' as const,
      message: {
        role: 'model' as const,
        content: [
          {
            toolRequest: {
              name: text.slice('call '.length),
              ref: 'call-1',
              input: {},
            },
          },
        ],
      },
    };
  }
  return reply('unknown command');
});
