import {
  createUserScopedStore,
  defineDetachedTurns,
  onAgentRequest,
  onAgentTask,
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
  enableTelemetryAtColdStart,
  type KitGenkit,
  kitMiddlewarePlugins,
  withLazyLocation,
} from './lib.js';

export type {
  AgentAuthContext,
  AgentRequestContext,
} from '@cabljac/firebase-agent-kit-core';
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
requiresAPI(
  'cloudtasks.googleapis.com',
  'Queues detached agent turns for the agentWorker function.',
);
requiresAPI(
  'cloudtrace.googleapis.com',
  'Receives Genkit traces when GOOGLE_CLOUD_TELEMETRY is enabled.',
);
requiresAPI(
  'monitoring.googleapis.com',
  'Receives Genkit metrics when GOOGLE_CLOUD_TELEMETRY is enabled.',
);
requiresAPI(
  'logging.googleapis.com',
  'Receives Genkit logs when GOOGLE_CLOUD_TELEMETRY is enabled.',
);
requiresRole('roles/aiplatform.user');
requiresRole('roles/datastore.user');
requiresRole('roles/cloudtasks.enqueuer');
requiresRole('roles/firebaseauth.viewer');
requiresRole('roles/run.invoker');
requiresRole('roles/cloudtrace.agent');
requiresRole('roles/monitoring.metricWriter');
requiresRole('roles/logging.logWriter');

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

const detachedTurns = defineBoolean('DETACHED_TURNS', {
  label: 'Detached turns (experimental)',
  description:
    'If enabled, a client can send a turn with detach: true. The turn runs in the agentWorker function, through Cloud Tasks, and the client follows it with its snapshot id. If disabled, such a turn gets 400 and agentWorker refuses work.',
  default: false,
  input: select({ Enabled: true, Disabled: false }),
});

const workerTimeoutSeconds = defineInt('WORKER_TIMEOUT_SECONDS', {
  label: 'Detached turn timeout in seconds',
  description:
    'How long one detached turn can run in agentWorker, from 60 to 1800. The worker aborts the turn 20 seconds before this.',
  default: 540,
  input: {
    text: {
      example: '540',
      validationRegex: /^(?:[6-9]\d|[1-9]\d{2}|1[0-7]\d{2}|1800)$/,
      validationErrorMessage: 'Enter a whole number from 60 to 1800.',
    },
  },
});

const googleCloudTelemetry = defineBoolean('GOOGLE_CLOUD_TELEMETRY', {
  label: 'Google Cloud telemetry',
  description:
    'If enabled, Genkit exports the traces, metrics and logs of agent turns to Cloud Trace, Cloud Monitoring and Cloud Logging.',
  default: false,
  input: select({ Enabled: true, Disabled: false }),
});

const instanceId = process.env.FIREBASE_KIT_INSTANCE_ID ?? 'default';

if (getApps().length === 0) initializeApp();
enableTelemetryAtColdStart(() => googleCloudTelemetry.value());

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

const store = createUserScopedStore({ scope: instanceId });
const kitAgent = instance.definePromptAgent({
  promptName: instanceId,
  store,
});
const detach = defineDetachedTurns({
  queue: 'agentWorker',
  store,
  enabled: detachedTurns,
  timeoutSeconds: workerTimeoutSeconds,
  instanceId,
});
const promptCheck = createPromptCheck({
  registry: instance.registry,
  instanceId,
  knownTools: () => toolNames,
  booleanParams: [
    enforceAppCheck.name,
    detachedTurns.name,
    googleCloudTelemetry.name,
  ],
  detachedTurns: {
    enabled: detachedTurns.name,
    workerTimeoutSeconds: workerTimeoutSeconds.name,
    turnTimeoutSeconds: timeoutSeconds.name,
  },
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
  detach,
});

/**
 * The instance's detached turn worker, run by Cloud Tasks. It refuses every
 * task unless the `DETACHED_TURNS` param is `true`.
 */
export const agentWorker = onAgentTask(kitAgent, detach, {
  memory,
  rateLimits: { maxConcurrentDispatches: 10 },
});
