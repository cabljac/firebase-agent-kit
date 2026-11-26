import { vertexAI } from '@genkit-ai/google-genai';
import { logger } from 'firebase-functions';
import { type ActionContext, GenkitError, ToolInterruptError } from 'genkit';
import { GenkitBeta, genkit, z } from 'genkit/beta';
import { UserRefreshClient } from 'google-auth-library';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  checkAtColdStart,
  createKitGenkit,
  createPromptCheck,
  findPromptAgentProblems,
  withAuthedContext,
  withLazyLocation,
} from '../../src/lib.js';

vi.mock('firebase-functions', () => ({ logger: { error: vi.fn() } }));

afterEach(() => {
  vi.mocked(logger.error).mockClear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

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

describe('withAuthedContext', () => {
  const interrupt = (): never => {
    throw new Error('interrupted');
  };
  const toolOptions = (context: ActionContext) => ({
    streamingRequested: false,
    sendChunk: () => {},
    trace: { traceId: 't', spanId: 's' },
    abortSignal: new AbortController().signal,
    inputStream: (async function* () {})(),
    init: undefined,
    interrupt,
    resumed: { approved: true },
    context,
  });

  test('throws UNAUTHENTICATED without Firebase Auth in the context', async () => {
    const fn = vi.fn(async () => 'ok');
    const tool = withAuthedContext('lookupOrder', fn);
    await expect(tool({}, toolOptions({}))).rejects.toMatchObject({
      status: 'UNAUTHENTICATED',
      message:
        'UNAUTHENTICATED: Tool lookupOrder requires an authenticated caller.',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  test('forwards the input and the tool options with the authed context', async () => {
    const fn = vi.fn(async () => 'ok');
    const tool = withAuthedContext('lookupOrder', fn);
    const context = { auth: { uid: 'u1', token: {}, rawToken: 't' } };
    const options = toolOptions(context);
    await expect(tool({ orderId: 'o1' }, options)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledWith(
      { orderId: 'o1' },
      expect.objectContaining({
        context,
        interrupt,
        resumed: { approved: true },
        abortSignal: options.abortSignal,
      }),
    );
  });
});

describe('createKitGenkit', () => {
  const kit = () => {
    const instance = genkit({});
    const toolNames = new Set<string>();
    return { instance, toolNames, ai: createKitGenkit(instance, toolNames) };
  };
  const authed = { auth: { uid: 'u1', token: {}, rawToken: 't' } };

  test('defineTool rejects a call without Firebase Auth with UNAUTHENTICATED', async () => {
    const { ai } = kit();
    const fn = vi.fn(async () => 'ok');
    const tool = ai.defineTool(
      { name: 'lookupOrder', description: 'd', inputSchema: z.object({}) },
      fn,
    );
    await expect(tool({}, { context: {} })).rejects.toMatchObject({
      status: 'UNAUTHENTICATED',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  test('defineTool passes the caller uid to the tool function', async () => {
    const { ai } = kit();
    const tool = ai.defineTool(
      {
        name: 'whoami',
        description: 'd',
        inputSchema: z.object({}),
        outputSchema: z.string(),
      },
      async (_input, { context }) => context.auth.uid,
    );
    await expect(tool({}, { context: authed })).resolves.toBe('u1');
  });

  test('defineTool and defineInterrupt register on the real instance and record the names', async () => {
    const { ai, instance, toolNames } = kit();
    ai.defineTool(
      { name: 'lookupOrder', description: 'd', inputSchema: z.object({}) },
      async () => 'ok',
    );
    const interrupt = ai.defineInterrupt({
      name: 'approveRefund',
      description: 'd',
      inputSchema: z.object({}),
      outputSchema: z.object({ approved: z.boolean() }),
    });
    expect([...toolNames]).toEqual(['lookupOrder', 'approveRefund']);
    expect(
      await instance.registry.lookupAction('/tool/lookupOrder'),
    ).toBeDefined();
    expect(
      await instance.registry.lookupAction('/tool/approveRefund'),
    ).toBeDefined();
    await expect(interrupt({}, { context: authed })).rejects.toBeInstanceOf(
      ToolInterruptError,
    );
  });

  test('has no own data for deploy discovery to walk', () => {
    const { ai } = kit();
    expect(Object.keys(ai).sort()).toEqual(['defineInterrupt', 'defineTool']);
  });

  test('other members pass through to the real instance', async () => {
    const { ai, instance, toolNames } = kit();
    expect(ai).toBeInstanceOf(GenkitBeta);
    expect(ai.registry).toBe(instance.registry);
    ai.defineModel({ name: 'test/echo' }, async (request) => ({
      finishReason: 'stop',
      message: {
        role: 'model',
        content: request.messages.at(-1)?.content ?? [],
      },
    }));
    const flow = ai.defineFlow('double', async (n: number) => n * 2);
    ai.definePrompt({ name: 'greet', model: 'test/echo', messages: 'hello' });

    expect(
      await instance.registry.lookupAction('/model/test/echo'),
    ).toBeDefined();
    await expect(flow(2)).resolves.toBe(4);
    const reply = await ai.prompt('greet')();
    expect(reply.text).toBe('hello');
    expect(toolNames.size).toBe(0);
  });
});

describe('createPromptCheck', () => {
  test('logs the problem and throws FAILED_PRECONDITION', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
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
      'Agent kit instance "typo" lists tools that are not defined: lookupOrdr. Fix the tools: list in prompts/typo.prompt or define the tools with ai.defineTool.',
      {
        instanceId: 'typo',
        missingPrompt: false,
        missingTools: ['lookupOrdr'],
        knownTools: ['lookupOrder', 'userTool'],
      },
    );
  });

  test('puts the problem in the error message in the Functions emulator', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
    const { ai } = setup();
    const check = createPromptCheck({
      registry: ai.registry,
      instanceId: 'missing',
      knownTools: () => [],
    });
    await expect(check()).rejects.toMatchObject({
      status: 'FAILED_PRECONDITION',
      originalMessage:
        'Agent kit instance "missing" has no prompt: add prompts/missing.prompt to the function source directory.',
    });
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

describe('checkAtColdStart', () => {
  test('runs the check after the current module code finishes', async () => {
    const check = vi.fn(async () => undefined);
    checkAtColdStart(check);
    expect(check).not.toHaveBeenCalled();
    await nextTick();
    expect(check).toHaveBeenCalledOnce();
  });

  test('does not run during deploy discovery', async () => {
    vi.stubEnv('FUNCTIONS_CONTROL_API', 'true');
    const check = vi.fn(async () => undefined);
    checkAtColdStart(check);
    await nextTick();
    expect(check).not.toHaveBeenCalled();
  });

  test('leaves the log of a failed prompt check to the check itself', async () => {
    const { ai } = setup();
    checkAtColdStart(
      createPromptCheck({
        registry: ai.registry,
        instanceId: 'missing',
        knownTools: () => [],
      }),
    );
    await nextTick();
    await nextTick();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'Agent kit instance "missing" has no prompt: add prompts/missing.prompt to the function source directory.',
      expect.anything(),
    );
  });

  test('logs an unexpected error instead of rejecting', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const err = new Error('registry broke');
      checkAtColdStart(async () => {
        throw err;
      });
      await nextTick();
      await nextTick();
      expect(logger.error).toHaveBeenCalledWith(
        'Agent kit configuration check failed at cold start.',
        err,
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('withLazyLocation', () => {
  const generateResponse = () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'hi' }] },
            finishReason: 'STOP',
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );

  test.each([
    ['europe-west1', 'https://europe-west1-aiplatform.googleapis.com/'],
    ['global', 'https://aiplatform.googleapis.com/'],
  ])(
    'the Vertex AI plugin reads location %s on the first model call',
    async (value, base) => {
      vi.stubEnv('GCLOUD_PROJECT', 'demo-test');
      const authClient = new UserRefreshClient();
      authClient.setCredentials({
        access_token: 'test-token',
        expiry_date: Date.now() + 3_600_000,
      });
      const location = vi.fn(() => value);
      const ai = genkit({
        plugins: [
          vertexAI(withLazyLocation(location, { googleAuth: { authClient } })),
        ],
      });
      expect(location).not.toHaveBeenCalled();

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => generateResponse());
      await ai.generate({ model: 'vertexai/gemini-2.5-flash', prompt: 'hi' });
      const url = String(fetchSpy.mock.calls[0]?.[0]);
      expect(url.startsWith(base)).toBe(true);
      expect(url).toContain(`/projects/demo-test/locations/${value}/`);
    },
  );
});

describe('createPromptCheck boolean params', () => {
  const checkFor = (booleanParams: string[]) => {
    const { ai, definePrompt } = setup();
    definePrompt('support', []);
    return createPromptCheck({
      registry: ai.registry,
      instanceId: 'support',
      knownTools: () => [],
      booleanParams,
    });
  };

  test.each([
    ['true', 'true'],
    ['false', 'false'],
    ['unset', undefined],
  ])('passes when the value is %s', async (_label, value) => {
    vi.stubEnv('AGENT_TEST_FLAG', value);
    await expect(checkFor(['AGENT_TEST_FLAG'])()).resolves.toBeUndefined();
  });

  test.each(['TRUE', 'yes', '1', 'true ', ''])(
    'rejects the value %j, which firebase-functions would read as false',
    async (value) => {
      vi.stubEnv('FUNCTIONS_EMULATOR', '');
      vi.stubEnv('AGENT_TEST_FLAG', value);
      const description = `Agent kit instance "support" has an invalid value for AGENT_TEST_FLAG: ${JSON.stringify(value)}. Set it to exactly true or false in config-support/.env.<projectId>.`;
      await expect(checkFor(['AGENT_TEST_FLAG'])()).rejects.toMatchObject({
        status: 'FAILED_PRECONDITION',
        originalMessage:
          'Agent kit instance "support" is misconfigured. See the function logs.',
      });
      expect(logger.error).toHaveBeenCalledWith(description, {
        instanceId: 'support',
        invalidParams: { AGENT_TEST_FLAG: value },
      });
    },
  );

  test('puts the invalid value in the error message in the Functions emulator', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
    vi.stubEnv('AGENT_TEST_FLAG', 'yes');
    await expect(checkFor(['AGENT_TEST_FLAG'])()).rejects.toMatchObject({
      originalMessage:
        'Agent kit instance "support" has an invalid value for AGENT_TEST_FLAG: "yes". Set it to exactly true or false in config-support/.env.<projectId>.',
    });
  });

  test('a cold start check logs an invalid value', async () => {
    vi.stubEnv('AGENT_TEST_FLAG', 'TRUE');
    checkAtColdStart(checkFor(['AGENT_TEST_FLAG']));
    await nextTick();
    await nextTick();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
