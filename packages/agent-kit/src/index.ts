import {
  createUserScopedStore,
  onAgentRequest,
} from '@cabljac/firebase-agent-kit-core';
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
import { genkit, z } from 'genkit/beta';
import {
  acceptMiddlewareNames,
  checkAtColdStart,
  createKitGenkit,
  createPromptCheck,
  type KitGenkit,
  kitMiddlewarePlugins,
  withLazyLocation,
} from './lib.js';

export type { AgentRequestContext } from '@cabljac/firebase-agent-kit-core';
export type { KitGenkit, KitToolFn } from './lib.js';
/** Genkit's Zod, for the schemas of tools defined with `ai.defineTool`. */
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

const instance = genkit({
  plugins: [
    vertexAI(withLazyLocation(() => vertexLocation.value())),
    ...kitMiddlewarePlugins(instanceId),
  ],
});
acceptMiddlewareNames(instance.registry);
const toolNames = new Set<string>();

/**
 * The kit's Genkit instance, shared by every tool, model and prompt of the
 * instance. `ai.defineTool` gives the tool function the caller's Firebase
 * Auth in `context.auth` and fails with `UNAUTHENTICATED` without it. Every
 * other member is Genkit's own.
 */
export const ai: KitGenkit = createKitGenkit(instance, toolNames);

const kitAgent = instance.definePromptAgent({
  promptName: instanceId,
  store: createUserScopedStore({ scope: instanceId }),
});
const promptCheck = createPromptCheck({
  registry: instance.registry,
  instanceId,
  knownTools: () => toolNames,
  booleanParams: [enforceAppCheck.name],
});
checkAtColdStart(promptCheck);

/**
 * The instance's agent endpoint, driven by `prompts/<instance id>.prompt` and
 * `skills/<instance id>/` in the function source directory. Routes match
 * `remoteAgent({ url })`.
 */
export const agent = onAgentRequest(kitAgent, {
  httpsOptions: { cors: corsOrigins, timeoutSeconds, memory },
  enforceAppCheck,
  authorize: promptCheck,
});
