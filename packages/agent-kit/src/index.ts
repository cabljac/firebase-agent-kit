import type { ToolFn } from '@genkit-ai/ai/tool';
import { setDebugSkipTokenVerification } from '@genkit-ai/firebase/context';
import { vertexAI } from '@genkit-ai/google-genai';
import { getApps, initializeApp } from 'firebase-admin/app';
import { requiresAPI, requiresRole } from 'firebase-functions/v2';
import type { HttpsOptions } from 'firebase-functions/v2/https';
import type { ToolAction, ToolConfig } from 'genkit';
import { type GenkitBeta, genkit, z } from 'genkit/beta';
import { createUserScopedStore, onAgentRequest } from 'genkit-agent-functions';
import { createPromptCheck } from './lib.js';

export * from './lib.js';
/** Genkit's Zod, for the schemas of tools defined with {@link defineKitTool}. */
export { z };

requiresAPI(
  'aiplatform.googleapis.com',
  'Calls Gemini models on Vertex AI for agent turns.',
);
requiresAPI(
  'firestore.googleapis.com',
  'Stores agent sessions and per-session turn locks.',
);
requiresRole('roles/aiplatform.user');
requiresRole('roles/datastore.user');

const instanceId = process.env.FIREBASE_KIT_INSTANCE_ID ?? 'default';

if (getApps().length === 0) initializeApp();
// The emulator's unsigned ID tokens fail the skip-verification decoder; verify them against the Auth emulator instead.
if (process.env.FUNCTIONS_EMULATOR === 'true') {
  setDebugSkipTokenVerification(false);
}

const ai = genkit({ plugins: [vertexAI()] });
const toolNames = new Set<string>();

/**
 * Registers a tool that an instance prompt can name in its `tools:`
 * frontmatter. Takes the same arguments as Genkit's `ai.defineTool`. The tool
 * function receives the caller's auth in `context.auth`.
 */
export function defineKitTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  config: ToolConfig<I, O>,
  fn: ToolFn<I, O>,
): ToolAction<I, O> {
  const tool = ai.defineTool(config, fn);
  toolNames.add(config.name);
  return tool;
}

/**
 * Registers a model that an instance prompt can name in its `model:`
 * frontmatter, for example a custom or test model. Takes the same arguments
 * as Genkit's `ai.defineModel`.
 */
export const defineKitModel: GenkitBeta['defineModel'] =
  ai.defineModel.bind(ai);

const store = createUserScopedStore();
const kitAgent = ai.definePromptAgent({ promptName: instanceId, store });
const httpsOptions: HttpsOptions = { timeoutSeconds: 60 };

/**
 * The instance's agent endpoint, driven by `prompts/<instance id>.prompt` in
 * the function source directory. Routes match `remoteAgent({ url })`.
 */
export const agent = onAgentRequest(kitAgent, {
  store,
  httpsOptions,
  beforeTurn: createPromptCheck({
    registry: ai.registry,
    instanceId,
    knownTools: () => toolNames,
  }),
});
