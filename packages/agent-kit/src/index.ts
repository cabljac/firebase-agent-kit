import { vertexAI } from '@genkit-ai/google-genai';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  defineBoolean,
  defineInt,
  defineList,
  defineString,
  select,
} from 'firebase-functions/params';
import { requiresAPI, requiresRole } from 'firebase-functions/v2';
import type { InterruptConfig, ToolAction, ToolConfig } from 'genkit';
import { type GenkitBeta, genkit, z } from 'genkit/beta';
import { createUserScopedStore, onAgentRequest } from 'genkit-agent-functions';
import {
  checkAtColdStart,
  createPromptCheck,
  type KitToolFn,
  withAuthedContext,
  withLazyLocation,
} from './lib.js';

export type { AgentRequestContext } from 'genkit-agent-functions';
export type { KitToolFn } from './lib.js';
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

const corsOrigins = defineList('CORS_ORIGINS', {
  label: 'Allowed browser origins',
  description:
    'Web origins that may call this agent from a browser, separated by commas, for example https://app.example.com,http://localhost:5173. Leave empty to allow no browser origin. Server clients do not need this.',
  default: [],
  input: {
    text: {
      example: 'https://app.example.com',
      validationRegex: /^$|^https?:\/\/[^\s,/]+(,https?:\/\/[^\s,/]+)*$/,
      validationErrorMessage:
        'Enter origins such as https://app.example.com, separated by commas, with no paths or spaces.',
    },
  },
});

const timeoutSeconds = defineInt('TIMEOUT_SECONDS', {
  label: 'Turn timeout in seconds',
  description:
    'How long one agent turn can run before Cloud Functions stops it, from 1 to 3600. The per-session turn lock lasts this long plus 30 seconds.',
  default: 60,
  input: {
    text: {
      example: '60',
      validationRegex: /^(?:[1-9]\d{0,2}|[12]\d{3}|3[0-5]\d{2}|3600)$/,
      validationErrorMessage: 'Enter a whole number from 1 to 3600.',
    },
  },
});

const memory = defineInt('MEMORY', {
  label: 'Function memory',
  description: 'Memory for each instance of the agent function, in MiB.',
  default: 256,
  input: select({
    '256 MiB': 256,
    '512 MiB': 512,
    '1 GiB': 1024,
    '2 GiB': 2048,
    '4 GiB': 4096,
  }),
});

const enforceAppCheck = defineBoolean('ENFORCE_APP_CHECK', {
  label: 'Enforce App Check',
  description:
    'If enabled, every request must also carry a valid App Check token in the X-Firebase-AppCheck header.',
  default: false,
  input: select({ Enabled: true, Disabled: false }),
});

const vertexLocation = defineString('VERTEX_LOCATION', {
  label: 'Vertex AI location',
  description:
    'The Vertex AI location for model calls. It can differ from the function region. Use global for models that only the global endpoint serves, such as preview models. See [available locations](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations).',
  default: 'us-central1',
  input: {
    text: {
      example: 'us-central1',
      validationRegex: /^[a-z0-9-]+$/,
      validationErrorMessage:
        'Enter a location id such as us-central1, europe-west1 or global.',
    },
  },
});

const instanceId = process.env.FIREBASE_KIT_INSTANCE_ID ?? 'default';

if (getApps().length === 0) initializeApp();

const ai = genkit({
  plugins: [vertexAI(withLazyLocation(() => vertexLocation.value()))],
});
const toolNames = new Set<string>();

/**
 * Registers a tool that an instance prompt can name in its `tools:`
 * frontmatter. Takes the same arguments as Genkit's `ai.defineTool`. The tool
 * function receives the caller's auth in `context.auth`, and a call without
 * it fails with `UNAUTHENTICATED`.
 */
export function defineKitTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  config: ToolConfig<I, O>,
  fn: KitToolFn<I, O>,
): ToolAction<I, O> {
  const tool = ai.defineTool(config, withAuthedContext(config.name, fn));
  toolNames.add(config.name);
  return tool;
}

/**
 * Registers an interrupt that an instance prompt can name in its `tools:`
 * frontmatter. Takes the same arguments as Genkit's `ai.defineInterrupt`. A
 * turn that calls it ends with `finishReason: 'interrupted'`, and the client
 * answers with `chat.resume({ respond })`.
 */
export function defineKitInterrupt<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
>(config: InterruptConfig<I, O>): ToolAction<I, O> {
  const interrupt = ai.defineInterrupt(config);
  toolNames.add(config.name);
  return interrupt;
}

/**
 * Registers a model that an instance prompt can name in its `model:`
 * frontmatter, for example a model served by your own backend or a scripted
 * model for tests. Takes the same arguments as Genkit's `ai.defineModel`.
 */
export const defineKitModel: GenkitBeta['defineModel'] =
  ai.defineModel.bind(ai);

const kitAgent = ai.definePromptAgent({
  promptName: instanceId,
  store: createUserScopedStore(),
});
const promptCheck = createPromptCheck({
  registry: ai.registry,
  instanceId,
  knownTools: () => toolNames,
  booleanParams: [enforceAppCheck.name],
});
checkAtColdStart(promptCheck);

/**
 * The instance's agent endpoint, driven by `prompts/<instance id>.prompt` in
 * the function source directory. Routes match `remoteAgent({ url })`.
 */
export const agent = onAgentRequest(kitAgent, {
  httpsOptions: { cors: corsOrigins, timeoutSeconds, memory },
  enforceAppCheck,
  authorize: promptCheck,
});
