import { fileURLToPath } from 'node:url';
import { type ToolAction, toToolDefinition } from '@genkit-ai/ai/tool';
import { beforeAll, expect, test } from 'vitest';
import { instance, toolNames } from './kit.js';

const tools = fileURLToPath(
  new URL(
    '../../../../examples/game-master/function-kits/firebase-agent-kit/source/src/tools.ts',
    import.meta.url,
  ),
);

const names = [
  'attemptRiskyAction',
  'createCharacter',
  'getCharacter',
  'rollDice',
  'updateCharacter',
];

beforeAll(async () => {
  // A variable specifier keeps tsc out of the example, whose imports resolve only in vitest.
  await import(tools);
});

/** The path of every `$ref` key in a JSON value. */
function refPaths(value: unknown, path = '#'): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === '$ref' ? [`${path}/$ref -> ${String(child)}`] : []),
    ...refPaths(child, `${path}/${key}`),
  ]);
}

test('registers the five game master tools', () => {
  expect([...toolNames].sort()).toEqual(names);
});

// Vertex AI Gemini rejects a function declaration whose schema uses $ref.
test.each(names)('the tool definition of %s has no $ref', async (name) => {
  const tool = await instance.registry.lookupAction(`/tool/${name}`);
  const definition = toToolDefinition(tool as ToolAction);
  expect(refPaths(definition.inputSchema)).toEqual([]);
  expect(refPaths(definition.outputSchema)).toEqual([]);
});
