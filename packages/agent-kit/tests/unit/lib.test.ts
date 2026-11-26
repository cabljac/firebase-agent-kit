import { logger } from 'firebase-functions';
import { GenkitError } from 'genkit';
import { genkit, z } from 'genkit/beta';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createPromptCheck, findPromptAgentProblems } from '../../src/lib.js';

vi.mock('firebase-functions', () => ({ logger: { error: vi.fn() } }));

afterEach(() => {
  vi.mocked(logger.error).mockClear();
});

function setup() {
  const ai = genkit({});
  const defineTool = (name: string) =>
    ai.defineTool(
      { name, description: name, inputSchema: z.object({}) },
      async () => 'ok',
    );
  const definePrompt = (name: string, tools: string[]) =>
    ai.definePrompt({ name, tools, messages: 'hello' });
  return { ai, defineTool, definePrompt };
}

describe('findPromptAgentProblems', () => {
  test('passes when the prompt exists and every tool resolves', async () => {
    const { ai, defineTool, definePrompt } = setup();
    defineTool('lookupOrder');
    definePrompt('helper', []);
    definePrompt('support', ['lookupOrder', 'helper']);
    await expect(
      findPromptAgentProblems(ai.registry, 'support'),
    ).resolves.toBeUndefined();
  });

  test('reports a missing prompt', async () => {
    const { ai } = setup();
    await expect(findPromptAgentProblems(ai.registry, 'nope')).resolves.toEqual(
      { missingPrompt: true, missingTools: [] },
    );
  });

  test('reports every tool name that resolves to nothing', async () => {
    const { ai, defineTool, definePrompt } = setup();
    defineTool('userTool');
    definePrompt('typo', ['lookupOrdr', 'userTool', 'quotePrise']);
    await expect(findPromptAgentProblems(ai.registry, 'typo')).resolves.toEqual(
      { missingPrompt: false, missingTools: ['lookupOrdr', 'quotePrise'] },
    );
  });
});

describe('createPromptCheck', () => {
  test('logs the problem and throws FAILED_PRECONDITION', async () => {
    const { ai, defineTool, definePrompt } = setup();
    defineTool('userTool');
    defineTool('lookupOrder');
    definePrompt('typo', ['lookupOrdr', 'userTool']);
    const check = createPromptCheck({
      registry: ai.registry,
      instanceId: 'typo',
      knownTools: () => new Set(['userTool', 'lookupOrder']),
    });

    const err = await check().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GenkitError);
    expect(err).toMatchObject({
      status: 'FAILED_PRECONDITION',
      code: 400,
      originalMessage:
        'Agent kit instance "typo" is misconfigured. See the function logs.',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Agent kit instance "typo" lists tools that are not defined: lookupOrdr. Fix the tools: list in prompts/typo.prompt or define the tools with defineKitTool.',
      {
        instanceId: 'typo',
        missingPrompt: false,
        missingTools: ['lookupOrdr'],
        knownTools: ['lookupOrder', 'userTool'],
      },
    );
  });

  test('logs a missing prompt with the expected file path', async () => {
    const { ai } = setup();
    const check = createPromptCheck({
      registry: ai.registry,
      instanceId: 'missing',
      knownTools: () => [],
    });
    await expect(check()).rejects.toMatchObject({
      status: 'FAILED_PRECONDITION',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Agent kit instance "missing" has no prompt: add prompts/missing.prompt to the function source directory.',
      {
        instanceId: 'missing',
        missingPrompt: true,
        missingTools: [],
        knownTools: [],
      },
    );
  });

  test('checks again after a failure and caches a pass', async () => {
    const { ai, defineTool, definePrompt } = setup();
    definePrompt('support', ['lookupOrder']);
    const lookup = vi.spyOn(ai.registry, 'lookupAction');
    const check = createPromptCheck({
      registry: ai.registry,
      instanceId: 'support',
      knownTools: () => [],
    });

    await expect(check()).rejects.toBeInstanceOf(GenkitError);
    await expect(check()).rejects.toBeInstanceOf(GenkitError);
    defineTool('lookupOrder');
    await expect(check()).resolves.toBeUndefined();
    const lookupsAfterPass = lookup.mock.calls.length;
    await expect(check()).resolves.toBeUndefined();
    expect(lookup.mock.calls.length).toBe(lookupsAfterPass);
  });
});
