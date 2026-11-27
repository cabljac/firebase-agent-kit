# @cabljac/firebase-agent-kit

A Firebase Function Kit that serves a [Genkit](https://genkit.dev) agent from Cloud Functions. Each kit instance is one agent: its `.prompt` file sets the model, the tools and the system prompt, and you write the tools in your own code. Every instance deploys one HTTPS function, `kit-<instance id>-agent`, that the stock `remoteAgent` client can talk to.

> **Status:** experimental community project. It is not an official Firebase or Genkit project, and it is not for production use. The package is not on npm yet, so the install needs [one extra step](#with-firebase-functionskitsinstall). APIs and package names may change. It requires Genkit 1.44 (beta agents API), Node.js 22.12 or later and firebase-tools 15.27.0 or later (checked against 15.36.0).

Every instance gets:

- **Auth on every route**, with optional App Check.
- **Per-user sessions per instance** in Firestore. One user cannot read, resume or abort the session of another user, and one instance cannot load the session of another instance.
- **One turn at a time** per session, with a per-session turn lock. A second turn on a busy session gets 409 `ABORTED`.
- **Streaming and interrupts** through the stock `remoteAgent` client.
- **Gemini on Vertex AI** with Application Default Credentials, so no API key.
- **Skills** per instance, and `retry` and `fallback` for model calls, from the `use:` list of the prompt.
- **Clear configuration errors** for the prompt file, its `tools:` and `use:` lists, the skills and the params.
- **Per-instance params** for CORS, timeout, memory, App Check, the Vertex AI location and Google Cloud telemetry.

The kit is built on [`@cabljac/firebase-agent-kit-core`](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/core#readme).

## Install

The `kits` experiment is on by default in firebase-tools 15.36.0. If the CLI says it is off, run `firebase experiments:enable kits`.

### With `firebase functions:kits:install`

Run this in a Firebase project directory (one with a `firebase.json`):

```sh
firebase functions:kits:install --package @cabljac/firebase-agent-kit
```

- `--package` takes an npm registry name, with an optional version (`@cabljac/firebase-agent-kit@1.2.3`). The CLI rejects paths, git URLs and tarballs. Before the package is on npm, point npm at a registry that has it. The CLI runs `npm install` in `function-kits/firebase-agent-kit/source`, so an `.npmrc` in the project root is not read. Set the registry in your user config (`npm config set registry <url>`, which writes `~/.npmrc`) or in the `NPM_CONFIG_REGISTRY` environment variable.
- `--directory <dir>` is a different flow. It turns a functions codebase that is already inside the project into a kit, with no wrapper and no npm package. It does not install this package from a local path.
- The CLI asks you to confirm, because the package is outside the `@firebase-function-kits` scope. It installs the package with `--ignore-scripts`.
- The CLI asks for the kit name and the instance name. Both default to `firebase-agent-kit`, from the unscoped package name. This README assumes the default kit name. Instance names are up to 40 characters of lowercase letters, digits, `_` and `-`, and cannot start or end with `-`.
- The CLI asks for a region, because the generated wrapper defines a `FUNCTION_DEFAULT_REGION` param. Then it asks for the [params](#configuration). It writes the answers to `function-kits/firebase-agent-kit/config-<instance>/.env.<projectId>`. `--no-configure` skips these questions. Then write that file yourself, with a value for every param.
- The CLI runs without prompts when it detects an AI agent, when stdin is not a terminal, or with `--non-interactive`. Then the kit and the instance get the default names, and the install fails on the confirmation and on the param questions. Pass `--force --no-configure`, then write `config-<instance>/.env.<projectId>` as shown in [Configuration](#configuration). Or pass `--interactive` to keep the prompts.

The install adds a kit stanza like this one to `firebase.json`:

```json
{
  "functions": [
    {
      "kit": "firebase-agent-kit",
      "sourcePackage": { "name": "@cabljac/firebase-agent-kit" },
      "source": "function-kits/firebase-agent-kit/source",
      "instances": {
        "support": "function-kits/firebase-agent-kit/config-support"
      },
      "predeploy": ["npm --prefix \"$RESOURCE_DIR\" run build"]
    }
  ]
}
```

The layout after the install:

```
function-kits/firebase-agent-kit/
  source/
    package.json                  generated: depends on the kit, firebase-functions and firebase-admin
    tsconfig.json                 generated
    .gitignore                    generated
    src/index.ts                  your wrapper: re-exports the kit, and you define tools here
    prompts/<instance-id>.prompt  one prompt per instance, named after the instance id (you create these)
    skills/<instance-id>/         optional skills of one instance, see Skills
  config-<instance-id>/.env.<projectId>
```

The install does not create the prompt file. See [Customise](#customise).

### By hand

Install the package in a functions codebase:

```sh
npm install @cabljac/firebase-agent-kit
```

Re-export the kit from the entry file:

```ts
// src/index.ts
export * from '@cabljac/firebase-agent-kit';
```

The function then deploys to `us-central1`. To pick the region, call `setGlobalOptions({ region })` before the kit loads, as in [the wrapper order rule](#the-wrapper-order-rule).

Add a kit stanza to `firebase.json`. `instances` maps each instance id to the directory, relative to `firebase.json`, that holds the `.env.<projectId>` file of that instance:

```json
{
  "functions": [
    {
      "kit": "firebase-agent-kit",
      "source": "functions",
      "instances": {
        "support": "functions/config-support"
      }
    }
  ]
}
```

Use a `.env.<projectId>` file, not a plain `.env`. `firebase functions:kits:uninstall` deletes deployed functions only for an instance with a `.env.<projectId>` file.

## Required IAM

The kit declares these roles and APIs:

| Role / API                      | Why                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `roles/aiplatform.user`         | Call Gemini models on Vertex AI for agent turns.                             |
| `roles/datastore.user`          | Read and write the sessions, the turn locks and the detached runs.           |
| `roles/cloudtasks.enqueuer`     | Enqueue detached turns for `agentWorker`.                                    |
| `roles/run.invoker`             | Let the ID token on each detached turn task call `agentWorker`.              |
| `roles/firebaseauth.viewer`     | Let `agentWorker` read the user (`getUser`) before it runs a detached turn.  |
| `roles/cloudtrace.agent`        | Write Genkit traces when `GOOGLE_CLOUD_TELEMETRY` is on.                     |
| `roles/monitoring.metricWriter` | Write Genkit metrics when `GOOGLE_CLOUD_TELEMETRY` is on.                    |
| `roles/logging.logWriter`       | Write Genkit logs when `GOOGLE_CLOUD_TELEMETRY` is on.                       |
| `aiplatform.googleapis.com`     | Vertex AI, for the model calls.                                              |
| `firestore.googleapis.com`      | Firestore, for the sessions and the per-session turn locks.                  |
| `cloudtasks.googleapis.com`     | Cloud Tasks, for detached turns. Declared even when `DETACHED_TURNS` is off. |
| `cloudtrace.googleapis.com`     | Cloud Trace, for telemetry.                                                  |
| `monitoring.googleapis.com`     | Cloud Monitoring, for telemetry.                                             |
| `logging.googleapis.com`        | Cloud Logging, for telemetry.                                                |

Params cannot change the declared roles and APIs, so the telemetry ones are granted even when `GOOGLE_CLOUD_TELEMETRY` is off. They only allow writes of traces, metrics and logs. `roles/logging.logWriter` allows writes to any log name in the project.

Detached turns need no other IAM. In a kit, firebase-admin puts an ID token for the kit's service account in the `Authorization` header of each task, not an OIDC token, so Cloud Tasks does not check `iam.serviceAccounts.actAs`. Do not grant `roles/iam.serviceAccountUser`.

The roles are granted at the project level. Tools run as the same service account, so with `roles/cloudtasks.enqueuer` and `roles/run.invoker` a tool could enqueue tasks or invoke other Cloud Run services in the project. Keep that in mind when you write tools.

The first deploy creates a `firebase-fn-*` service account for the kit, grants it these roles at the project level, enables the APIs and attaches the account to the function of every instance. So the account that deploys needs `iam.serviceAccounts.create` and `resourcemanager.projects.setIamPolicy` (for example through `roles/owner`, or `roles/iam.serviceAccountAdmin` and `roles/resourcemanager.projectIamAdmin`).

Do not set a custom runtime service account for the kit's codebase. It conflicts with this automatic setup.

## Customise

### The prompt file

Each instance reads `prompts/<instance id>.prompt` from the function source directory (`function-kits/firebase-agent-kit/source`). Create one file per instance:

```
---
model: vertexai/gemini-2.5-flash
tools: [lookupOrder, approveRefund]
---
{{role "system"}}
You are the support agent. Use lookupOrder to answer questions about orders.
Ask with approveRefund before you promise a refund.
```

Without this file, every request gets 400 `FAILED_PRECONDITION` and the function log names the missing file.

### Tools

The kit exports `ai`, its own Genkit instance. Define tools with `ai.defineTool`. It takes the same arguments as Genkit's `ai.defineTool`, but the tool function gets the signed-in caller in `context.auth`, with `context.auth.uid` typed as `string`. A call without a signed-in caller fails with `UNAUTHENTICATED`, for example from the Genkit Developer UI without an auth context.

```ts
// ...generated code, up to and including the setGlobalOptions({ region: regionParam, ... }) call

import { ai, z } from '@cabljac/firebase-agent-kit';

ai.defineTool(
  {
    name: 'lookupOrder',
    description: "Look up one of the caller's orders.",
    inputSchema: z.object({ orderId: z.string() }),
  },
  async ({ orderId }, { context }) => {
    const uid = context.auth.uid; // the signed-in caller, as a string
    // ...read only data that belongs to uid
  },
);

// Exports the functions located in the kit.
export * from '@cabljac/firebase-agent-kit';
```

### Interrupts

Use `ai.defineInterrupt` to ask the user before a tool writes or spends. It takes the same arguments as Genkit's `ai.defineInterrupt`. Name it in the `tools:` list of the prompt like any tool. The client answers with `chat.resume({ respond })`. The response comes from the client, so the server does not verify it.

```ts
ai.defineInterrupt({
  name: 'approveRefund',
  description: 'Ask the user to approve a refund.',
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  outputSchema: z.object({ approved: z.boolean() }),
});
```

#### Restartable approvals

An interrupt only asks. The prompt tells the model to ask before it acts, and the model can skip the question. To make the approval a rule of the code, put it in the tool that acts. The tool calls `interrupt({ kind: 'approval', ... })` on its first run. The client answers with a `restart` entry that sends `{ approved: true }` or `{ approved: false }` in the tool's `context.resumed`, and the tool runs again with the same input:

```ts
ai.defineTool(
  {
    name: 'issueRefund',
    description: 'Refund an order. The user approves each refund.',
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    outputSchema: z.object({ refunded: z.boolean() }),
  },
  async ({ orderId, amount }, { context, interrupt, resumed }) => {
    if (!resumed) {
      interrupt({
        kind: 'approval',
        summary: `Refund ${amount} for ${orderId}`,
      });
    }
    if (typeof resumed !== 'object' || resumed.approved !== true) {
      return { refunded: false }; // declined
    }
    // ...refund the order of context.auth.uid
    return { refunded: true };
  },
);
```

- The refund code runs only after an approval, whatever the model does.
- `interrupt` throws, so the code after it runs only on a restart.
- The client sends `context.resumed`, so the server does not verify it. The tool still checks `context.auth`, and it can check again what it is about to do.
- A restart must send the original input. The server answers `INVALID_ARGUMENT` when the input differs.
- `kind: 'approval'` is the convention that tells a client to restart the tool instead of answering it, for example [`fak`](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/cli#readme). Genkit sends the `interrupt(...)` object to the client as `metadata.interrupt` of the tool request. Do not put `kind: 'approval'` in the `requestMetadata` of `ai.defineInterrupt`: an interrupt has no code to run again, so it asks again.

A client that builds the restart itself must add `metadata.resumed`. Genkit's `interrupt.restart()` sends no metadata, so the tool sees no `context.resumed` and asks again. `response.interrupts` also drops the interrupt metadata, so a client that needs to detect `kind: 'approval'` reads `response.toolRequests[i].metadata.interrupt`:

```ts
const [approval] = response.interrupts;
await chat.resume({
  restart: [
    { ...approval.restart(), metadata: { resumed: { approved: true } } },
  ],
});
```

### Skills

A skill is a set of instructions that the model loads only when it needs them. Put the skills of an instance in `skills/<instance id>/` in the function source directory. Each skill is a directory with a `SKILL.md` file:

```
source/
  prompts/support.prompt
  skills/support/
    refunds/SKILL.md
    shipping/SKILL.md
```

The directory name is the skill name. `SKILL.md` starts with YAML frontmatter that has a `description`. Write the description plain, unquoted and on one line. The model reads the description to decide when to load the skill:

```
---
description: How to handle a refund request.
---
Look up the order with lookupOrder before you offer a refund.
Ask with approveRefund before you promise a refund over 100 USD.
```

Turn skills on with `use: [skills]` in the prompt:

```
---
model: vertexai/gemini-2.5-flash
tools: [lookupOrder, approveRefund]
use: [skills]
---
{{role "system"}}
You are the support agent.
```

On each turn, the kit adds a `<skills>` block to the system prompt, with the name and the description of each skill. It also gives the model a `use_skill` tool. When the model calls `use_skill` with a skill name, the tool returns the full text of that `SKILL.md` file.

- Skills are text only. A skill grants no tools. The model can call only `use_skill` and the tools in the `tools:` list, whatever a skill says.
- The model can repeat the text of a skill to the user. Do not put secrets in a `SKILL.md` file.
- By default, an instance reads only its own `skills/<instance id>/` directory. The kit ignores directories whose names start with `.`.
- The kit reads the skill files from the deployed function source directory. To change a skill, edit the file and deploy again. The kit skips skill directories that are symbolic links, and it checks paths by name only, without following links.

To read skills from other directories, set `skillPaths`. Each path is relative to the function source directory and must be inside it:

```
use:
  - name: skills
    config: { skillPaths: [skills/shared, skills/support] }
```

### Retry and fallback

The `use:` list can also name the `retry` and `fallback` middleware of [`@genkit-ai/middleware`](https://www.npmjs.com/package/@genkit-ai/middleware). Both act on model calls.

`retry` calls the model again after an error, with exponential backoff. By default, it retries 3 times on `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, `ABORTED` and `INTERNAL`, and on errors that are not Genkit errors. The retries count toward `TIMEOUT_SECONDS`.

```
use:
  - name: retry
    config: { maxRetries: 2, initialDelayMs: 500 }
```

`fallback` calls the next model in `models` when the model fails with one of the statuses above, `NOT_FOUND` or `UNIMPLEMENTED`. It needs `models` with at least one model, so a bare `fallback` fails the configuration checks:

```
---
model: vertexai/gemini-2.5-pro
use:
  - name: fallback
    config:
      models: [{ name: vertexai/gemini-2.5-flash }]
---
```

A bare name uses the default config, for example `use: [skills, retry]`. The kit registers only `skills`, `retry` and `fallback`. Any other name fails the [configuration checks](#configuration-checks).

### Models and everything else

Every other member of `ai` is Genkit's own. For example, `ai.defineModel` registers a model that a prompt can name in its `model:` frontmatter, such as a model served by your own backend or a scripted model for tests. `ai.defineFlow`, `ai.definePrompt`, `ai.prompt` and `ai.generate` work as in Genkit.

Every instance runs the whole wrapper, so every tool you define is registered in every instance. Only the `tools:` list in the prompt of an instance decides which tools its model can call. If the model asks for a tool that the list does not name, the turn fails: `chat.send` rejects with an `AgentError` with status `NOT_FOUND` and the message `Tool <name> not found`.

### The wrapper order rule

Put your code, including its `import` lines, below the generated `setGlobalOptions({ region: regionParam })` call. The wrapper compiles to CommonJS, where each `import` runs at its place in the file. If `@cabljac/firebase-agent-kit` loads before `setGlobalOptions` runs, the kit's function gets no region and deploys to the default region (`us-central1`). Below that call, your definitions can come before or after the `export * from '@cabljac/firebase-agent-kit'` line. You can also put them in their own file and import that file below the call.

In an ES module codebase, every `import` and `export ... from` runs before the code of the file. There, call `setGlobalOptions` in a module of its own and import that module before the kit.

The `timeoutSeconds` and `memory` of `setGlobalOptions` do not apply to the kit's function. The `TIMEOUT_SECONDS` and `MEMORY` params set them.

### `agent` and `agentWorker` are reserved export names

The kit exports its functions as `agent` and `agentWorker`. Do not export anything else with these names from the wrapper. A local export with one of them silently replaces the kit's function.

## Deploy

Deploy one instance by its instance id:

```sh
firebase deploy --only functions:support
```

The filter is the instance id, not the function name: do not use `--only functions:kit-<instance-id>-agent`. `firebase deploy --only functions` deploys every instance and every other codebase.

The first deploy asks you to confirm the managed service account (see [Required IAM](#required-iam)). A non-interactive first deploy (in CI, with `--non-interactive`, or from an AI agent) needs `--force` to confirm it.

For about 30 seconds after the first deploy, requests can get an HTML 401 page ("The access token could not be verified") from the Google front end, until public access to the function takes effect. Retry after a short wait.

When the `.env.<projectId>` file has no value for a param, an interactive deploy asks for it. A non-interactive deploy fails and does not use the default.

The production URL is:

```
https://<region>-<project>.cloudfunctions.net/kit-<instance id>-agent
```

Every deploy also creates `kit-<instance id>-agentWorker`, a Cloud Tasks function, and its task queue. Params cannot change which functions a kit exports, so the worker is deployed even with `DETACHED_TURNS=false`. It then refuses every task and costs nothing while idle. Before you turn detached turns on, set the TTL policy for the run documents:

```sh
gcloud firestore fields ttls update expireAt \
  --collection-group=agent-kit-runs --enable-ttl
```

### Run it locally

Model calls go to Vertex AI, so use a real project (not a `demo-` project) with the Vertex AI API on, and Application Default Credentials:

```sh
gcloud auth application-default login
firebase emulators:start --only functions,firestore,auth --project <project>
```

The instance URL is `http://127.0.0.1:5001/<project>/<region>/kit-<instance id>-agent`. Get a token from the Auth emulator as in [Local development](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/core#local-development). The emulator asks for a missing param value in a terminal and uses the default without one. It writes the value to `config-<instance>/.env.local`.

## Configuration

Each instance has its own values for these params, in `config-<instance>/.env.<projectId>`:

| Param                    | Type             | Default       | Description                                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGINS`           | list of strings  | empty         | The web origins that can call the instance from a browser. This is the `cors` option of the function. Empty means no CORS headers, so browsers cannot call. Server clients do not need it.                                                                                        |
| `TIMEOUT_SECONDS`        | integer, 1-3600  | `60`          | The function timeout. The turn lock lease is this value plus 30 seconds.                                                                                                                                                                                                          |
| `MEMORY`                 | integer, in MiB  | `256`         | The function memory. The CLI offers 256, 512, 1024, 2048 and 4096.                                                                                                                                                                                                                |
| `ENFORCE_APP_CHECK`      | boolean          | `false`       | Exactly `true` or `false`. When `true`, every request also needs a valid App Check token in the `X-Firebase-AppCheck` header, or it gets 403 `PERMISSION_DENIED`. Any other value fails the [configuration checks](#configuration-checks).                                        |
| `VERTEX_LOCATION`        | string           | `us-central1` | The Vertex AI location for model calls. It can differ from the function region. Use `global` for models that only the global endpoint serves.                                                                                                                                     |
| `DETACHED_TURNS`         | boolean          | `false`       | Experimental. Exactly `true` or `false`. When `true`, a turn with `detach: true` runs in `agentWorker` through Cloud Tasks. When `false`, it gets 400 `FAILED_PRECONDITION` and the worker refuses work. Any other value fails the [configuration checks](#configuration-checks). |
| `WORKER_TIMEOUT_SECONDS` | integer, 60-1800 | `540`         | The timeout of `agentWorker`, so the longest a detached turn can run. The worker aborts the turn 20 seconds before it.                                                                                                                                                            |
| `GOOGLE_CLOUD_TELEMETRY` | boolean          | `false`       | Exactly `true` or `false`. When `true`, Genkit exports the traces, metrics and logs of the instance to Cloud Trace, Cloud Monitoring and Cloud Logging. Any other value fails the [configuration checks](#configuration-checks).                                                  |

A full file looks like this:

```
FUNCTION_DEFAULT_REGION=us-central1
CORS_ORIGINS=["https://app.example.com","http://localhost:5173"]
TIMEOUT_SECONDS=120
MEMORY=512
ENFORCE_APP_CHECK=false
VERTEX_LOCATION=us-central1
DETACHED_TURNS=false
WORKER_TIMEOUT_SECONDS=540
GOOGLE_CLOUD_TELEMETRY=false
```

To change a value, edit the file and deploy again.

**`CORS_ORIGINS` format.** Write the list as JSON, as in the file above. The install prompt takes a comma-separated list and writes it without brackets (`CORS_ORIGINS=https://app.example.com,http://localhost:5173`). A deploy reads both forms, but the Functions emulator reads only the JSON form. With the comma form, the instance sends no CORS headers in the emulator. To allow no browser origin, leave the value empty (`CORS_ORIGINS=`).

An empty list makes firebase-functions log a warning on every request, except in one case:

- `CORS_ORIGINS=[]` in production logs `CORS parameter resolved to an empty array. Disabling CORS.`
- `CORS_ORIGINS=` in the emulator logs `Failed to resolve CORS parameter`.
- `CORS_ORIGINS=` in production logs nothing.

> **Note:** the browser enforces the origin list, not the function. When `CORS_ORIGINS` is not empty, the Functions emulator answers a preflight from any origin. A deployed function with one origin in the list sends that origin in `Access-Control-Allow-Origin` to every caller. With two or more, it sends the header only to a listed origin. In each case, a browser on an origin that is not in the list blocks the response.

**Vertex AI location.** The default `VERTEX_LOCATION` is `us-central1` for every function region, so a function in an EU region still sends model traffic to `us-central1` until you change it.

**`ENFORCE_APP_CHECK`** works in the emulator only with a real project and the App Check debug provider.

**`DETACHED_TURNS`** is experimental. With it on, the [configuration checks](#configuration-checks) also require `WORKER_TIMEOUT_SECONDS` to be a whole number from 60 to 1800 and `TIMEOUT_SECONDS` to be 60 or more (the turn route waits up to 40 seconds for the worker). The worker runs at most 10 detached turns of an instance at a time, with no per-user limit, so one user can fill the queue. See [Detached turns](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/core#detached-turns-experimental) for how they work, and for their limits: a 30-minute cap, claims frozen at enqueue with a user check when the worker starts, no raw ID token in the worker, and App Check, `authorize` and the configuration checks only when the turn is sent. In a detached turn, a tool's `context.auth` has `uid` and `token` but no `rawToken`.

**`GOOGLE_CLOUD_TELEMETRY`** calls `enableGoogleCloudTelemetry` from `@genkit-ai/google-cloud` once per instance. The first request to `agent` or `agentWorker` waits for the call. With the param off, the kit does not load `@genkit-ai/google-cloud`. Telemetry needs `roles/cloudtrace.agent`, `roles/monitoring.metricWriter` and `roles/logging.logWriter` (see [Required IAM](#required-iam)), and Google Cloud Observability bills for it.

- **A failed setup fails turns.** When the setup fails (for example, no credentials), every agent turn on that instance fails until the instance shuts down. Cloud Functions does not restart it for this, so redeploy to replace it. If the module cannot load, every request fails. The kit logs `Agent kit could not enable Google Cloud telemetry. Agent turns on this instance fail until it shuts down. Redeploy to replace it.` with the cause.
- **Do not enable telemetry twice.** With the param on, do not also call `enableGoogleCloudTelemetry()` in the wrapper or set `ENABLE_FIREBASE_MONITORING=true`.

### Configuration checks

The kit checks that `prompts/<instance id>.prompt` exists, that every name in its `tools:` list is defined, that every entry in its `use:` list is a name or `{ name, config }`, that every name is `skills`, `retry` or `fallback`, that `fallback` has at least one model, and that `ENFORCE_APP_CHECK`, `DETACHED_TURNS` and `GOOGLE_CLOUD_TELEMETRY` are exactly `true` or `false`. firebase-functions reads any other value as `false`, which would turn App Check off without a sign. If a check fails, the kit logs the details, with the names of the tools you defined, through the `firebase-functions` logger.

For [skills](#skills), the kit also checks that:

- `skills/<instance id>/` exists when the `use:` list names `skills` without `skillPaths`.
- `skills/<instance id>/` does not exist when the `use:` list does not name `skills`.
- `skillPaths` is not an empty list, and each entry is a directory inside the function source directory.
- Each skills directory has at least one skill.
- Each skill directory has a `SKILL.md` file, and its frontmatter has a `description:` line that is not empty. The description is plain text on that line, not quoted and not a `|` or `>` block.

- **At cold start.** When an instance starts, the kit runs the check once in the background and logs any problem. A failed check does not stop the instance. The check does not run during deploy discovery, so a deploy does not read the skill files.
- **On each request.** Until the check passes, every request runs it again, on every route. A failed check answers 400 `FAILED_PRECONDITION`. Without the check, Genkit would return HTTP 200 with a failed turn and log nothing, and with an invalid `ENFORCE_APP_CHECK` the `/getSnapshot`, `/waitForSnapshot` and `/abort` routes would run without App Check.

In production, the 400 message only says that the instance is misconfigured. In the Functions emulator, the message holds the details:

```json
{
  "status": "FAILED_PRECONDITION",
  "message": "Agent kit instance \"support\" lists tools that are not defined: lookupOrdr. Fix the tools: list in prompts/support.prompt or define the tools with ai.defineTool."
}
```

## Multiple instances

Run `firebase functions:kits:install --package @cabljac/firebase-agent-kit` again. The CLI finds the installed kit and asks for the new instance name. Then add `prompts/<new instance>.prompt`. By hand, add one entry per instance to the `instances` map, each with its own config directory:

```json
{
  "functions": [
    {
      "kit": "firebase-agent-kit",
      "sourcePackage": { "name": "@cabljac/firebase-agent-kit" },
      "source": "function-kits/firebase-agent-kit/source",
      "instances": {
        "support": "function-kits/firebase-agent-kit/config-support",
        "sales": "function-kits/firebase-agent-kit/config-sales"
      }
    }
  ]
}
```

Instance ids must be unique across all kit stanzas in the project. Each instance deploys its own `kit-<instance id>-agent` function with its own params and prompt. All instances share the session and lock collections. Each instance keys its sessions by the instance id and the user, so one instance cannot load the sessions of another instance. The turn lock is keyed by the user and the session id only, so a turn on one instance also blocks a concurrent turn of the same user with the same session id on another instance.

**Upgrade the kit.** Run `npm install @cabljac/firebase-agent-kit@<version>` in `function-kits/firebase-agent-kit/source`.

## Chat with it

**From the terminal.** [`fak`](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/cli#readme) finds the instances from `firebase.json` and `.firebaserc`, signs in with email and password, and streams replies:

```sh
fak support --email you@example.com
```

Until the package is on npm, [build `fak` from this repo](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/cli#run-it) and alias it.

**From an app.** Use the stock `remoteAgent` client with a Firebase ID token:

```ts
import { getAuth } from 'firebase/auth';
import { remoteAgent } from 'genkit/beta/client';

const auth = getAuth();

const agent = remoteAgent({
  url: 'https://<region>-<project>.cloudfunctions.net/kit-support-agent',
  headers: async () => {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in first.');
    return { Authorization: `Bearer ${await user.getIdToken()}` };
  },
});
const reply = await agent.chat().send('Hello');
```

For a browser client, set `CORS_ORIGINS` to your web origins and deploy again. See [Client](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/core#client) for sessions, streaming, interrupts, App Check and errors.

## Security

> **Warning:** tools run as the function's service account, which has Admin SDK access. They bypass Firestore security rules.

- Build data paths from `context.auth.uid`. Never build them from model output alone.
- Keep tool input schemas narrow.
- Get user approval before a tool writes or spends. A [restartable approval](#restartable-approvals) puts the check in the tool's code; `ai.defineInterrupt` relies on the prompt.
- Keep the five collections the kit writes closed to client SDKs: `agent-kit-sessions`, `agent-kit-sessions-pointers`, `agent-kit-sessions-shards` (the message history), `agent-kit-locks` and `agent-kit-runs` (detached runs). Your Firestore rules must deny all client reads and writes there:

  ```
  match /agent-kit-sessions/{document=**} {
    allow read, write: if false;
  }
  match /agent-kit-sessions-pointers/{document=**} {
    allow read, write: if false;
  }
  match /agent-kit-sessions-shards/{document=**} {
    allow read, write: if false;
  }
  match /agent-kit-locks/{document=**} {
    allow read, write: if false;
  }
  match /agent-kit-runs/{document=**} {
    allow read, write: if false;
  }
  ```

  Firestore allows a request when any rule allows it. A broad rule such as `match /{document=**} { allow read: if request.auth != null; }` lets every signed-in user read every user's sessions and message history, whatever the rules above say.

## API surface

The main entry (`@cabljac/firebase-agent-kit`) exports:

- `agent`: the HTTPS function of the instance. Re-export it with `export * from '@cabljac/firebase-agent-kit'`.
- `agentWorker`: the Cloud Tasks function that runs detached turns. The same `export *` re-exports it.
- `ai`: the kit's Genkit instance, typed `KitGenkit`. `ai.defineTool` and `ai.defineInterrupt` are described in [Customise](#customise). Every other member is Genkit's own.
- `z`: Genkit's Zod, for tool schemas.
- Types: `KitGenkit`, `KitToolFn` (the tool function of `ai.defineTool`), `AgentAuthContext` (what a tool gets in `context`: `auth.uid` as a string and the decoded `auth.token`) and `AgentRequestContext` (the full context of an HTTP request).

The main entry reads the instance id and defines the params when it loads, so use it from Firebase deploy, the emulator or the runtime. To build your own function instead, use [`@cabljac/firebase-agent-kit-core`](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/core#readme).

## Limits

- **Detached turns are experimental and off by default.** See `DETACHED_TURNS` in [Configuration](#configuration).
- **Denied reads look like missing snapshots.** When a user asks `/getSnapshot` or `/waitForSnapshot` for a snapshot that is not theirs, the answer is 404 `NOT_FOUND`, the same as for an id that does not exist.
- **No session list.** There is no route that lists sessions. Clients must keep their own session ids.
- **Sessions belong to one instance.** All instances share the session collections, but each instance keys its sessions by the instance id and the user. When a client sends the snapshot id of another instance, the instance answers as for a snapshot of another user: `NOT_FOUND` on a turn, 404 `NOT_FOUND` on `/getSnapshot` and `/waitForSnapshot`. A turn with the session id of another instance starts a new session in this instance. If you rename an instance, its sessions stay under the old instance id, and the renamed instance cannot load them.
- **No cleanup.** Documents in the session and lock collections stay in Firestore until you delete them. The kit sets no TTL on them; run documents have an `expireAt` field for a TTL policy. A turn deletes its lock document when it ends, but a lock from a turn that did not end cleanly stays.
- **Abort of another user's turn does nothing.** `/abort` with the snapshot id of another user answers 200 with no `status`, and the turn continues. The client's `abort()` resolves `undefined`.
- **No multipart tools.** `ai.defineTool` takes no `multipart: true` config.
- **One model provider.** The kit registers only the Vertex AI plugin. Use `ai.defineModel` for anything else.
- **Upstream workarounds.** The kit patches and reads some Genkit internals. See [Upstream workarounds](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/core#upstream-workarounds).

## Reporting bugs

File bugs in the [issue tracker](https://github.com/cabljac/firebase-agent-kit/issues). Include:

- The kit version (run `npm ls @cabljac/firebase-agent-kit` in `function-kits/firebase-agent-kit/source`), your firebase-tools version (`firebase --version`) and your Node.js version.
- Your `config-<instance>/.env.<projectId>` file, with project details redacted.
- The steps to reproduce, the result you expected, and the result you got.
- The logs of the `kit-<instance id>-agent` function from Cloud Logging.

## License

Apache-2.0
