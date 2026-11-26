import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentAuthContext,
  isAuthedContext,
} from '@cabljac/firebase-agent-kit-core';
import type { ToolFn, ToolFnOptions, ToolRunOptions } from '@genkit-ai/ai/tool';
import type { vertexAI } from '@genkit-ai/google-genai';
import { fallback, retry, skills } from '@genkit-ai/middleware';
import { logger } from 'firebase-functions';
import {
  type GenerateMiddleware,
  GenkitError,
  generateMiddleware,
  type InterruptConfig,
  type ToolAction,
  type ToolConfig,
  z,
} from 'genkit';
import type { GenkitBeta } from 'genkit/beta';
import type { GenkitPluginV2 } from 'genkit/plugin';
import type { Registry } from 'genkit/registry';

/** What stops a prompt agent instance from running. */
export interface PromptAgentProblems {
  /** True when no prompt named after the instance is registered. */
  missingPrompt: boolean;
  /** Names in the prompt's `tools:` frontmatter that resolve to no action. */
  missingTools: string[];
  /** Names in the prompt's `use:` frontmatter that resolve to no middleware. */
  unknownMiddleware: string[];
  /** Malformed or incomplete `use:` entries, one sentence each. */
  useProblems: string[];
  /** Problems with the instance's skills, one sentence each. */
  skillProblems: string[];
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
  /**
   * The function source directory, which holds `skills/`. Defaults to the
   * working directory when the check runs.
   */
  sourceDir?: string;
}

/**
 * The function of a tool defined with `ai.defineTool`: Genkit's tool
 * function, with the caller's Firebase Auth in `context.auth`. In a detached
 * turn there is no raw ID token, so `context.auth` holds only `uid` and the
 * decoded `token` claims.
 */
export type KitToolFn<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = (
  input: z.infer<I>,
  options: Omit<ToolFnOptions & ToolRunOptions, 'context'> & {
    context: AgentAuthContext;
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

/**
 * The kit's Genkit instance. Every member is the real `GenkitBeta` member,
 * except `defineTool`, whose function gets the caller's Firebase Auth in
 * `context.auth` and fails with `UNAUTHENTICATED` without it, and
 * `defineInterrupt`. Both also record the name for the configuration check.
 */
export type KitGenkit = Omit<GenkitBeta, 'defineTool' | 'defineInterrupt'> & {
  /**
   * Registers a tool that an instance prompt can name in its `tools:`
   * frontmatter. Takes the same config as Genkit's `ai.defineTool`.
   */
  defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    config: ToolConfig<I, O>,
    fn: KitToolFn<I, O>,
  ): ToolAction<I, O>;
  /**
   * Registers an interrupt that an instance prompt can name in its `tools:`
   * frontmatter. Takes the same config as Genkit's `ai.defineInterrupt`.
   */
  defineInterrupt<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    config: InterruptConfig<I, O>,
  ): ToolAction<I, O>;
};

/**
 * Wraps `instance` as a {@link KitGenkit}. The names of the tools and
 * interrupts defined through the wrapper are added to `toolNames`.
 */
export function createKitGenkit(
  instance: GenkitBeta,
  toolNames: Set<string>,
): KitGenkit {
  const overrides: Pick<KitGenkit, 'defineTool' | 'defineInterrupt'> = {
    defineTool(config, fn) {
      const tool = instance.defineTool(
        config,
        withAuthedContext(config.name, fn),
      );
      toolNames.add(config.name);
      return tool;
    },
    defineInterrupt(config) {
      const interrupt = instance.defineInterrupt(config);
      toolNames.add(config.name);
      return interrupt;
    },
  };
  const base: GenkitBeta = Object.create(instance);
  return Object.assign(base, overrides);
}

const PromptMetadataSchema = z.object({
  prompt: z.object({ tools: z.array(z.string()).optional() }),
});

const PromptUseSchema = z.object({
  prompt: z.object({
    raw: z.object({ use: z.unknown() }).partial().optional(),
    use: z.unknown(),
  }),
});

const UseEntrySchema = z.union([
  z.string().transform((name) => ({ name, config: undefined })),
  z.object({ name: z.string(), config: z.unknown().optional() }),
]);

const FallbackConfigSchema = z.object({
  models: z.array(z.object({ name: z.string() })).min(1),
});

interface UseEntry {
  name: string;
  config?: unknown;
}

// The raw list, because Genkit drops malformed entries from the normalized one.
function parseUse(metadata: unknown): {
  entries: UseEntry[];
  problems: string[];
} {
  const parsed = PromptUseSchema.safeParse(metadata);
  if (!parsed.success) return { entries: [], problems: [] };
  const { raw, use } = parsed.data.prompt;
  const list = raw && 'use' in raw ? raw.use : use;
  if (!Array.isArray(list)) return { entries: [], problems: [] };
  const entries: UseEntry[] = [];
  const problems: string[] = [];
  for (const item of list) {
    const entry = UseEntrySchema.safeParse(item);
    if (entry.success) {
      entries.push(entry.data);
    } else {
      problems.push(
        `entry ${JSON.stringify(item)} is not a middleware name or { name, config }`,
      );
    }
  }
  for (const entry of entries) {
    if (
      entry.name === 'fallback' &&
      !FallbackConfigSchema.safeParse(entry.config).success
    ) {
      problems.push('fallback needs config.models with at least one model');
    }
  }
  return { entries, problems };
}

const SkillsConfigSchema = z.object({
  skillPaths: z
    .array(z.string())
    .optional()
    .describe(
      'Directories of skills, relative to the function source directory. Defaults to skills/<instance id>.',
    ),
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
 * Checks that the prompt `promptName` is registered, that every name in its
 * `tools:` frontmatter resolves the way Genkit resolves tools at generate
 * time, that every name in its `use:` frontmatter is a registered middleware,
 * and that its skills in `sourceDir` are valid. Returns `undefined` when the
 * prompt agent can run.
 */
export async function findPromptAgentProblems(
  registry: Registry,
  promptName: string,
  sourceDir: string = process.cwd(),
): Promise<PromptAgentProblems | undefined> {
  const prompt = await registry.lookupAction(`/prompt/${promptName}`);
  if (!prompt) {
    return {
      missingPrompt: true,
      missingTools: [],
      unknownMiddleware: [],
      useProblems: [],
      skillProblems: [],
    };
  }
  const metadata = PromptMetadataSchema.safeParse(prompt.__action.metadata);
  const tools = metadata.success ? (metadata.data.prompt.tools ?? []) : [];
  const { entries: use, problems: useProblems } = parseUse(
    prompt.__action.metadata,
  );
  const missingTools: string[] = [];
  for (const name of tools) {
    if (!(await resolvesTool(registry, name))) missingTools.push(name);
  }
  const unknownMiddleware: string[] = [];
  for (const { name } of use) {
    if (!(await registry.lookupValue('middleware', name))) {
      unknownMiddleware.push(name);
    }
  }
  const skillProblems = await findSkillProblems(
    sourceDir,
    promptName,
    use.find((entry) => entry.name === 'skills'),
  );
  return missingTools.length > 0 ||
    unknownMiddleware.length > 0 ||
    useProblems.length > 0 ||
    skillProblems.length > 0
    ? {
        missingPrompt: false,
        missingTools,
        unknownMiddleware,
        useProblems,
        skillProblems,
      }
    : undefined;
}

function isInsideDir(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function listDirectories(dir: string): Promise<string[] | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }
}

function isFileNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err.code === 'ENOENT' || err.code === 'ENOTDIR')
  );
}

/**
 * Returns the `description` in the YAML frontmatter of a SKILL.md file, or
 * `undefined` when the `description:` line is missing or empty.
 */
export function skillDescription(content: string): string | undefined {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  return frontmatter
    ? /^description:[ \t]*(\S.*)$/m.exec(frontmatter)?.[1]?.trim()
    : undefined;
}

async function findSkillProblems(
  sourceDir: string,
  instanceId: string,
  entry: { config?: unknown } | undefined,
): Promise<string[]> {
  const prompt = `prompts/${instanceId}.prompt`;
  const defaultDir = path.join(sourceDir, 'skills', instanceId);
  if (!entry) {
    return (await listDirectories(defaultDir))
      ? [
          `skills/${instanceId}/ exists, but ${prompt} does not list skills in use:`,
        ]
      : [];
  }
  const config = SkillsConfigSchema.safeParse(entry.config ?? {});
  if (!config.success) {
    return [
      `the skills config in ${prompt} must be { skillPaths: [<directory>, ...] }`,
    ];
  }
  if (config.data.skillPaths?.length === 0) {
    return [`the skillPaths list in ${prompt} is empty`];
  }
  const problems: string[] = [];
  for (const skillPath of config.data.skillPaths ?? [defaultDir]) {
    const dir = path.resolve(sourceDir, skillPath);
    if (!isInsideDir(sourceDir, dir)) {
      problems.push(
        `skillPaths entry "${skillPath}" in ${prompt} is not inside the function source directory`,
      );
      continue;
    }
    const shown = path.relative(sourceDir, dir).split(path.sep).join('/');
    const skillDirs = await listDirectories(dir);
    if (!skillDirs) {
      problems.push(
        `${prompt} lists skills in use:, but ${shown}/ does not exist`,
      );
      continue;
    }
    if (skillDirs.length === 0) {
      problems.push(`${shown}/ has no skills`);
      continue;
    }
    for (const name of skillDirs) {
      const file = `${shown}/${name}/SKILL.md`;
      let content: string;
      try {
        content = await readFile(path.join(dir, name, 'SKILL.md'), 'utf8');
      } catch (err) {
        if (!isFileNotFound(err)) throw err;
        problems.push(`${file} does not exist`);
        continue;
      }
      const description = skillDescription(content);
      if (!description) {
        problems.push(`${file} has no description in its frontmatter`);
      } else if (/^["'|>]/.test(description)) {
        problems.push(
          `${file} has a quoted or multi-line description: write it plain, unquoted, on one line`,
        );
      }
    }
  }
  return problems;
}

const KIT_MIDDLEWARE = ['skills', 'retry', 'fallback'];

function describeProblems(
  instanceId: string,
  problems: PromptAgentProblems,
): string {
  const instance = `Agent kit instance "${instanceId}"`;
  const prompt = `prompts/${instanceId}.prompt`;
  if (problems.missingPrompt) {
    return `${instance} has no prompt: add ${prompt} to the function source directory.`;
  }
  const sentences: string[] = [];
  if (problems.missingTools.length > 0) {
    sentences.push(
      `${instance} lists tools that are not defined: ${problems.missingTools.join(', ')}. Fix the tools: list in ${prompt} or define the tools with ai.defineTool.`,
    );
  }
  if (problems.unknownMiddleware.length > 0) {
    sentences.push(
      `${instance} uses middleware that is not available: ${problems.unknownMiddleware.join(', ')}. Fix the use: list in ${prompt}. The kit provides ${KIT_MIDDLEWARE.join(', ')}.`,
    );
  }
  if (problems.useProblems.length > 0) {
    sentences.push(
      `${instance} has use: problems: ${problems.useProblems.join('; ')}. Fix the use: list in ${prompt}.`,
    );
  }
  if (problems.skillProblems.length > 0) {
    sentences.push(
      `${instance} has skill problems: ${problems.skillProblems.join('; ')}.`,
    );
  }
  return sentences.join(' ');
}

/**
 * Resolves the directories that the kit `skills` middleware scans:
 * `skills/<instanceId>` in `sourceDir`, or each of `skillPaths` relative to
 * `sourceDir`. Throws `FAILED_PRECONDITION` for a path outside `sourceDir`.
 */
export function resolveSkillPaths(
  sourceDir: string,
  instanceId: string,
  skillPaths?: string[],
): string[] {
  if (!skillPaths) return [path.join(sourceDir, 'skills', instanceId)];
  return skillPaths.map((skillPath) => {
    const dir = path.resolve(sourceDir, skillPath);
    if (!isInsideDir(sourceDir, dir)) {
      throw new GenkitError({
        status: 'FAILED_PRECONDITION',
        message: `Skill path "${skillPath}" is not inside the function source directory.`,
      });
    }
    return dir;
  });
}

/**
 * The `skills` middleware of `@genkit-ai/middleware`, scoped to one
 * instance. It reads skills from `skills/<instanceId>` in the directory that
 * `sourceDir()` returns when a generate call starts, and rejects a
 * `skillPaths` config outside that directory.
 */
export function instanceSkills(
  instanceId: string,
  sourceDir: () => string = () => process.cwd(),
): GenerateMiddleware<typeof SkillsConfigSchema> {
  return generateMiddleware(
    {
      name: 'skills',
      description: skills.description,
      configSchema: SkillsConfigSchema,
    },
    (options) =>
      skills.instantiate({
        ...options,
        config: {
          skillPaths: resolveSkillPaths(
            sourceDir(),
            instanceId,
            options.config?.skillPaths,
          ),
        },
      }),
  );
}

/**
 * The plugins that register the middleware a kit prompt can name in its
 * `use:` frontmatter: `skills` (see {@link instanceSkills}), `retry` and
 * `fallback`.
 */
export function kitMiddlewarePlugins(
  instanceId: string,
  sourceDir?: () => string,
): GenkitPluginV2[] {
  return [
    instanceSkills(instanceId, sourceDir).plugin(),
    retry.plugin(),
    fallback.plugin(),
  ];
}

/**
 * Makes a bare middleware name in the `use:` list of a `.prompt` file, such
 * as `use: [skills]`, reach generate calls. Genkit passes only `{ name }`
 * entries on and drops bare names without an error.
 */
export function acceptMiddlewareNames(registry: Registry): void {
  const { dotprompt } = registry;
  const renderMetadata = dotprompt.renderMetadata.bind(dotprompt);
  dotprompt.renderMetadata = async (source, additionalMetadata) => {
    const metadata = await renderMetadata(source, additionalMetadata);
    const use: unknown = metadata.raw?.use;
    if (metadata.raw && Array.isArray(use)) {
      metadata.raw.use = use.map((entry: unknown) =>
        typeof entry === 'string' ? { name: entry } : entry,
      );
    }
    return metadata;
  };
}

/**
 * Builds an `authorize` hook that checks the raw values of `booleanParams`,
 * the instance prompt, its tools, its middleware and its skills. On a problem
 * it logs the details and throws `FAILED_PRECONDITION`, whose
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
      opts.sourceDir,
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
