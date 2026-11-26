# @cabljac/firebase-agent-kit

> **Status:** experimental and pre-release. This is a community project, not an official Firebase or Genkit project, and it is not supported for production use. It is not published to npm yet. APIs, package names and behavior may change without notice. It requires Genkit 1.44 (beta agents API), Node.js 22.12 or later and firebase-tools 15.27.0 or later.

A Firebase Function Kit that serves a [Genkit](https://genkit.dev) agent from Cloud Functions. Each kit instance is one agent: its `.prompt` file sets the model, the tools and the system prompt, and you write the tools in your own code. Every instance deploys one HTTPS function, `kit-<instance id>-agent`, that the stock `remoteAgent` client can talk to.

Every instance gets:

- **Firebase Auth on every route**, with optional App Check.
- **Per-user sessions per instance** in Firestore. One user cannot read, resume or abort the session of another user, and one instance cannot load the session of another instance.
- **One turn at a time** per session. A second turn on a busy session gets 409.
- **Streaming and interrupts** through the stock `remoteAgent` client.
- **Gemini on Vertex AI** with Application Default Credentials, so no API key.
- **Configuration checks** for the prompt file, its `tools:` list and the params.
- **Per-instance params** for CORS, timeout, memory, App Check and the Vertex AI location.

The kit is built on [`@cabljac/firebase-agent-kit-core`](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/core#readme).

## Install

These steps are checked against firebase-tools 15.36.0. The `kits` experiment is on by default in that version. If the CLI says it is off, run `firebase experiments:enable kits`.

### With `firebase functions:kits:install`

Run this in a Firebase project directory (one with a `firebase.json`):

```sh
firebase functions:kits:install --package @cabljac/firebase-agent-kit
```

- `--package` takes an npm registry name, with an optional version (`@cabljac/firebase-agent-kit@1.2.3`). The CLI rejects paths, git URLs and tarballs. Before the package is on npm, point npm at a registry that has it. The CLI runs `npm install` in `function-kits/firebase-agent-kit/source`, so an `.npmrc` in the project root is not read. Set the registry in your user config (`npm config set registry <url>`, which writes `~/.npmrc`) or in the `NPM_CONFIG_REGISTRY` environment variable.
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
    src/index.ts            your wrapper: re-exports the kit, and you define tools here
    prompts/support.prompt  one prompt per instance, named after the instance id (you create these)
  config-support/.env.<projectId>
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

| Role / API                  | Why                                                         |
| --------------------------- | ----------------------------------------------------------- |
| `roles/aiplatform.user`     | Call Gemini models on Vertex AI for agent turns.            |
| `roles/datastore.user`      | Read and write the sessions and the turn locks.             |
| `aiplatform.googleapis.com` | Vertex AI, for the model calls.                             |
| `firestore.googleapis.com`  | Firestore, for the sessions and the per-session turn locks. |

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
// ...generated code, ending with setGlobalOptions({ region: regionParam });

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

### Models and everything else

Every other member of `ai` is Genkit's own. For example, `ai.defineModel` registers a model that a prompt can name in its `model:` frontmatter, such as a model served by your own backend or a scripted model for tests. `ai.defineFlow`, `ai.definePrompt`, `ai.prompt` and `ai.generate` work as in Genkit.

Every instance runs the whole wrapper, so every tool you define is registered in every instance. Only the `tools:` list in the prompt of an instance decides which tools its model can call. If the model asks for a tool that the list does not name, the turn fails: `chat.send` rejects with an `AgentError` with status `NOT_FOUND` and the message `Tool <name> not found`.

### The wrapper order rule

Put your code, including its `import` lines, below the generated `setGlobalOptions({ region: regionParam })` call. The wrapper compiles to CommonJS, where each `import` runs at its place in the file. If `@cabljac/firebase-agent-kit` loads before `setGlobalOptions` runs, the kit's function gets no region and deploys to the default region (`us-central1`). Below that call, your definitions can come before or after the `export * from '@cabljac/firebase-agent-kit'` line. You can also put them in their own file and import that file below the call.

In an ES module codebase, every `import` and `export ... from` runs before the code of the file. There, call `setGlobalOptions` in a module of its own and import that module before the kit.

The `timeoutSeconds` and `memory` of `setGlobalOptions` do not apply to the kit's function. The `TIMEOUT_SECONDS` and `MEMORY` params set them.

### `agent` is a reserved export name

The kit exports its function as `agent`. Do not export anything else named `agent` from the wrapper. A local export with that name silently replaces the kit's function.

## Deploy

Deploy one instance by its instance id:

```sh
firebase deploy --only functions:support
```

The filter is the instance id, not the function name: do not use `--only functions:kit-support-agent`. `firebase deploy --only functions` deploys every instance and every other codebase.

The first deploy asks you to confirm the managed service account (see [Required IAM](#required-iam)). A non-interactive first deploy (in CI, with `--non-interactive`, or from an AI agent) needs `--force` to confirm it.

When the `.env.<projectId>` file has no value for a param, an interactive deploy asks for it. A non-interactive deploy fails and does not use the default.

The production URL is:

```
https://<region>-<project>.cloudfunctions.net/kit-<instance id>-agent
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

| Param               | Type            | Default       | Description                                                                                                                                                                                                                                |
| ------------------- | --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CORS_ORIGINS`      | list of strings | empty         | The web origins that can call the instance from a browser. This is the `cors` option of the function. Empty means no CORS headers, so browsers cannot call. Server clients do not need it.                                                 |
| `TIMEOUT_SECONDS`   | integer, 1-3600 | `60`          | The function timeout. The turn lock lease is this value plus 30 seconds.                                                                                                                                                                   |
| `MEMORY`            | integer, in MiB | `256`         | The function memory. The CLI offers 256, 512, 1024, 2048 and 4096.                                                                                                                                                                         |
| `ENFORCE_APP_CHECK` | boolean         | `false`       | Exactly `true` or `false`. When `true`, every request also needs a valid App Check token in the `X-Firebase-AppCheck` header, or it gets 403 `PERMISSION_DENIED`. Any other value fails the [configuration checks](#configuration-checks). |
| `VERTEX_LOCATION`   | string          | `us-central1` | The Vertex AI location for model calls. It can differ from the function region. Use `global` for models that only the global endpoint serves.                                                                                              |

A full file looks like this:

```
FUNCTION_DEFAULT_REGION=us-central1
CORS_ORIGINS=["https://app.example.com","http://localhost:5173"]
TIMEOUT_SECONDS=120
MEMORY=512
ENFORCE_APP_CHECK=false
VERTEX_LOCATION=us-central1
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

### Configuration checks

The kit checks that `prompts/<instance id>.prompt` exists, that every name in its `tools:` list is defined, and that `ENFORCE_APP_CHECK` is exactly `true` or `false`. firebase-functions reads any other value as `false`, which would turn App Check off without a sign. If a check fails, the kit logs the details, with the names of the tools you defined, through the `firebase-functions` logger.

- **At cold start.** When an instance starts, the kit runs the check once in the background and logs any problem. A failed check does not stop the instance. The check does not run during deploy discovery.
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
npx @cabljac/firebase-agent-kit-cli support --email you@example.com
```

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
- Use `ai.defineInterrupt` to get user approval before a tool writes or spends.
- Keep the four collections the kit writes closed to client SDKs: `agent-kit-sessions`, `agent-kit-sessions-pointers`, `agent-kit-sessions-shards` (the message history) and `agent-kit-locks`. Your Firestore rules must deny all client reads and writes there:

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
  ```

  Firestore allows a request when any rule allows it. A broad rule such as `match /{document=**} { allow read: if request.auth != null; }` lets every signed-in user read every user's sessions and message history, whatever the rules above say.

## API surface

The main entry (`@cabljac/firebase-agent-kit`) exports:

- `agent`: the HTTPS function of the instance. Re-export it with `export * from '@cabljac/firebase-agent-kit'`.
- `ai`: the kit's Genkit instance, typed `KitGenkit`. `ai.defineTool` and `ai.defineInterrupt` are described in [Customise](#customise). Every other member is Genkit's own.
- `z`: Genkit's Zod, for tool schemas.
- Types: `KitGenkit`, `KitToolFn` (the tool function of `ai.defineTool`) and `AgentRequestContext` (the context with `auth.uid` as a string).

The main entry reads the instance id and defines the params when it loads, so use it from Firebase deploy, the emulator or the runtime. To build your own function instead, use [`@cabljac/firebase-agent-kit-core`](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/core#readme).

## Limits

- **No detached turns.** A request with `detach: true` gets 400 `FAILED_PRECONDITION`, because Cloud Functions throttles CPU after the response is sent.
- **Denied reads return 500.** When a user asks for a snapshot that is not theirs, `@genkit-ai/express` returns 500 for the `NOT_FOUND` error.
- **No session list.** There is no route that lists sessions. Clients must keep their own session ids.
- **Sessions belong to one instance.** All instances share the session collections, but each instance keys its sessions by the instance id and the user. When a client sends the snapshot id of another instance, the instance answers as for a snapshot of another user: `NOT_FOUND` on a turn, 500 on `/getSnapshot` and `/waitForSnapshot`. A turn with the session id of another instance starts a new session in this instance. If you rename an instance, its sessions stay under the old instance id, and the renamed instance cannot load them.
- **No cleanup.** Documents in all four collections stay in Firestore until you delete them. The kit sets no TTL. A turn deletes its lock document when it ends, but a lock from a turn that did not end cleanly stays.
- **No multipart tools.** `ai.defineTool` takes no `multipart: true` config.
- **One model provider.** The kit registers only the Vertex AI plugin. Use `ai.defineModel` for anything else.

## Reporting bugs

File bugs in the [issue tracker](https://github.com/cabljac/firebase-agent-kit/issues). Include:

- The kit version (run `npm ls @cabljac/firebase-agent-kit` in `function-kits/firebase-agent-kit/source`), your firebase-tools version (`firebase --version`) and your Node.js version.
- Your `config-<instance>/.env.<projectId>` file, with project details redacted.
- The steps to reproduce, the result you expected, and the result you got.
- The logs of the `kit-<instance id>-agent` function from Cloud Logging.

## License

Apache-2.0
