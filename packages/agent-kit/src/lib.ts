import { logger } from 'firebase-functions';
import { GenkitError, z } from 'genkit';
import type { Registry } from 'genkit/registry';

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
 * Builds a `beforeTurn` hook that checks the instance prompt and its tools.
 * On a problem it logs the details and throws `FAILED_PRECONDITION`; a
 * passing check is cached for later turns.
 */
export function createPromptCheck(
  opts: PromptValidationOptions,
): () => Promise<void> {
  let validated = false;
  return async () => {
    if (validated) return;
    const problems = await findPromptAgentProblems(
      opts.registry,
      opts.instanceId,
    );
    if (problems) {
      logger.error(describeProblems(opts.instanceId, problems), {
        instanceId: opts.instanceId,
        ...problems,
        knownTools: [...opts.knownTools()].sort(),
      });
      throw new GenkitError({
        status: 'FAILED_PRECONDITION',
        message: `Agent kit instance "${opts.instanceId}" is misconfigured. See the function logs.`,
      });
    }
    validated = true;
  };
}
