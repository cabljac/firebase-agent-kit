import type { ToolFn, ToolFnOptions, ToolRunOptions } from '@genkit-ai/ai/tool';
import type { vertexAI } from '@genkit-ai/google-genai';
import { logger } from 'firebase-functions';
import { GenkitError, z } from 'genkit';
import type { Registry } from 'genkit/registry';
import {
  type AgentRequestContext,
  isAuthedContext,
} from 'genkit-agent-functions';

/** What stops a prompt agent instance from running. */
export interface PromptAgentProblems {
  /** True when no prompt named after the instance is registered. */
  missingPrompt: boolean;
  /** Names in the prompt's `tools:` frontmatter that resolve to no action. */
  missingTools: string[];
}

/** Options for {@link createPromptCheck}. */
export interface PromptValidationOptions {
  /** Registry that holds the instance prompt and the tools. */
  registry: Registry;
  /** Kit instance id, which is also the prompt name. */
  instanceId: string;
  /** Names of the tools the kit and the user registered, for the error log. */
  knownTools: () => Iterable<string>;
  /**
   * Boolean params whose raw environment value must be exactly `true` or
   * `false` when set. firebase-functions reads any other value as `false`.
   */
  booleanParams?: string[];
}

/**
 * The function of a tool defined with {@link defineKitTool}: Genkit's tool
 * function, with the caller's Firebase Auth in `context.auth`.
 */
export type KitToolFn<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = (
  input: z.infer<I>,
  options: Omit<ToolFnOptions & ToolRunOptions, 'context'> & {
    context: AgentRequestContext;
  },
) => Promise<z.infer<O>>;

/**
 * Adapts `fn` to a Genkit tool function that requires Firebase Auth in the
 * call context and throws `UNAUTHENTICATED` without it.
 */
export function withAuthedContext<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
>(name: string, fn: KitToolFn<I, O>): ToolFn<I, O> {
  return async (input, options) => {
    const { context } = options;
    if (!isAuthedContext(context)) {
      throw new GenkitError({
        status: 'UNAUTHENTICATED',
        message: `Tool ${name} requires an authenticated caller.`,
      });
    }
    return fn(input, { ...options, context });
  };
}

const PromptMetadataSchema = z.object({
  prompt: z.object({ tools: z.array(z.string()).optional() }),
});

async function resolvesTool(
  registry: Registry,
  name: string,
): Promise<boolean> {
  if (name.includes(':')) {
    const names = await registry.resolveActionNames(
      `/dynamic-action-provider/${name}`,
    );
    if (names.length > 0) return true;
  }
  for (const key of [`/tool/${name}`, `/tool.v2/${name}`, `/prompt/${name}`]) {
    if (await registry.lookupAction(key)) return true;
  }
  return false;
}

/**
 * Checks that the prompt `promptName` is registered and that every name in
 * its `tools:` frontmatter resolves the way Genkit resolves tools at generate
 * time. Returns `undefined` when the prompt agent can run.
 */
export async function findPromptAgentProblems(
  registry: Registry,
  promptName: string,
): Promise<PromptAgentProblems | undefined> {
  const prompt = await registry.lookupAction(`/prompt/${promptName}`);
  if (!prompt) return { missingPrompt: true, missingTools: [] };
  const metadata = PromptMetadataSchema.safeParse(prompt.__action.metadata);
  const tools = metadata.success ? (metadata.data.prompt.tools ?? []) : [];
  const missingTools: string[] = [];
  for (const name of tools) {
    if (!(await resolvesTool(registry, name))) missingTools.push(name);
  }
  return missingTools.length > 0
    ? { missingPrompt: false, missingTools }
    : undefined;
}

function describeProblems(
  instanceId: string,
  problems: PromptAgentProblems,
): string {
  if (problems.missingPrompt) {
    return `Agent kit instance "${instanceId}" has no prompt: add prompts/${instanceId}.prompt to the function source directory.`;
  }
  return `Agent kit instance "${instanceId}" lists tools that are not defined: ${problems.missingTools.join(', ')}. Fix the tools: list in prompts/${instanceId}.prompt or define the tools with defineKitTool.`;
}

/**
 * Builds an `authorize` hook that checks the raw values of `booleanParams`,
 * the instance prompt and its tools. On a problem it logs the details and throws `FAILED_PRECONDITION`, whose
 * message holds the details only in the Functions emulator. A passing check
 * is cached for later turns.
 */
export function createPromptCheck(
  opts: PromptValidationOptions,
): () => Promise<void> {
  let validated = false;
  const fail = (description: string, details: object): never => {
    logger.error(description, { instanceId: opts.instanceId, ...details });
    throw new GenkitError({
      status: 'FAILED_PRECONDITION',
      message:
        process.env.FUNCTIONS_EMULATOR === 'true'
          ? description
          : `Agent kit instance "${opts.instanceId}" is misconfigured. See the function logs.`,
    });
  };
  return async () => {
    if (validated) return;
    const invalidParams = findInvalidBooleanParams(opts.booleanParams ?? []);
    if (invalidParams) {
      fail(describeInvalidParams(opts.instanceId, invalidParams), {
        invalidParams,
      });
    }
    const problems = await findPromptAgentProblems(
      opts.registry,
      opts.instanceId,
    );
    if (problems) {
      fail(describeProblems(opts.instanceId, problems), {
        ...problems,
        knownTools: [...opts.knownTools()].sort(),
      });
    }
    validated = true;
  };
}

function findInvalidBooleanParams(
  names: string[],
): Record<string, string> | undefined {
  const invalid = Object.fromEntries(
    names
      .map((name) => [name, process.env[name]] as const)
      .filter(
        (entry): entry is readonly [string, string] =>
          entry[1] !== undefined && entry[1] !== 'true' && entry[1] !== 'false',
      ),
  );
  return Object.keys(invalid).length > 0 ? invalid : undefined;
}

function describeInvalidParams(
  instanceId: string,
  invalidParams: Record<string, string>,
): string {
  const values = Object.entries(invalidParams)
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
    .join(', ');
  return `Agent kit instance "${instanceId}" has an invalid value for ${values}. Set it to exactly true or false in config-${instanceId}/.env.<projectId>.`;
}

/**
 * Starts `check` once in the background, after the code that is loading now
 * (for example the wrapper's tool definitions) has run. Does nothing during
 * deploy discovery. A `GenkitError` from the check is ignored, because the
 * prompt check logs its own problems; any other error is logged. Never throws.
 */
export function checkAtColdStart(check: () => Promise<void>): void {
  if (process.env.FUNCTIONS_CONTROL_API === 'true') return;
  setImmediate(() => {
    check().catch((err: unknown) => {
      if (err instanceof GenkitError) return;
      logger.error('Agent kit configuration check failed at cold start.', err);
    });
  });
}

type VertexAIOptions = NonNullable<Parameters<typeof vertexAI>[0]>;

/**
 * Returns `options` with a `location` that calls `location()` each time it is
 * read. The Vertex AI plugin reads it when it first resolves a model, so a
 * params `.value()` call in `location` runs at request time, not during
 * deploy discovery.
 */
export function withLazyLocation(
  location: () => string,
  options: VertexAIOptions = {},
): VertexAIOptions {
  return Object.defineProperty({ ...options }, 'location', {
    enumerable: true,
    get: location,
  });
}
