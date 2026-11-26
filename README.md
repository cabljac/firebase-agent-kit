# genkit-agent-functions

> **Status:** experimental. This is a personal demo, not an official Firebase or Genkit project, and it is not supported for production use. APIs, package names and behavior may change without notice.
>
> It is pre-release. The packages are not published to npm yet, and the names may change. It requires Genkit 1.44 (beta agents API) and Node.js 22.12 or later.

Serve [Genkit](https://genkit.dev) agents from Firebase Cloud Functions, with per-user sessions and one turn at a time per session.

`expressHandler(agent)` from `@genkit-ai/express` can already serve an agent from an `onRequest` function. This library adds what a multi-user production deployment needs on top of that route:

- **Firebase Auth on every route.** The turn route and the `/getSnapshot`, `/waitForSnapshot` and `/abort` routes all need a valid ID token. App Check is optional.
- **A uid-scoped session store.** One user cannot read, resume or abort the session of another user.
- **A per-session turn lock.** Two concurrent turns on one session get a clean 409 instead of racing on the same history.
- **A detach guard.** Detached (background) turns cannot finish reliably on Cloud Functions, so the library rejects them.

This repo has three packages:

| Package                                   | What it is                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `genkit-agent-functions` (repo root)      | A library. `onAgentRequest(agent, options)` turns a Genkit agent into an HTTPS function that the stock `remoteAgent` client can talk to. |
| `genkit-agent-kit` (`packages/agent-kit`) | A Firebase Function Kit built on the library. Each kit instance is an agent defined by a `.prompt` file, with tools you write yourself.  |
| `genkit-agent-chat` (`packages/cli`)      | A terminal chat client for agents served by the library or the kit. See [Terminal client](#terminal-client).                             |

## Library

### Usage

```ts
import { initializeApp } from 'firebase-admin/app';
import { genkit } from 'genkit/beta';
import { vertexAI } from '@genkit-ai/google-genai';
import { createUserScopedStore, onAgentRequest } from 'genkit-agent-functions';

initializeApp();

const ai = genkit({ plugins: [vertexAI()] });

const assistant = ai.defineAgent({
  name: 'assistant',
  model: 'vertexai/gemini-2.5-flash',
  system: 'You are a helpful assistant.',
  store: createUserScopedStore(),
});

export const assistantAgent = onAgentRequest(assistant, {
  httpsOptions: {
    timeoutSeconds: 120,
    cors: ['https://app.example.com'], // needed for browser clients, see below
  },
});
```

On the client, pass `headers` as a function. `remoteAgent` calls it before each request, and `getIdToken()` returns a fresh token when the cached one is about to expire. A static token stops working after one hour.

```ts
import { getAuth } from 'firebase/auth';
import { remoteAgent } from 'genkit/beta/client';

const auth = getAuth();

const agent = remoteAgent({
  url: 'https://<region>-<project>.cloudfunctions.net/assistantAgent',
  headers: async () => {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in first.');
    return { Authorization: `Bearer ${await user.getIdToken()}` };
  },
});
const chat = agent.chat();
const reply = await chat.send('Hello');
```

With `enforceAppCheck: true`, also send the App Check token in the `X-Firebase-AppCheck` header:

```ts
import { getApp } from 'firebase/app';
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';

// auth and remoteAgent as in the snippet above
const appCheck = initializeAppCheck(getApp(), {
  provider: new ReCaptchaEnterpriseProvider('<site key>'),
});

const agent = remoteAgent({
  url: 'https://<region>-<project>.cloudfunctions.net/assistantAgent',
  headers: async () => {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in first.');
    return {
      Authorization: `Bearer ${await user.getIdToken()}`,
      'X-Firebase-AppCheck': (await getToken(appCheck)).token,
    };
  },
});
```

See [Client](#client) for sessions, streaming, interrupts and errors.

### Browser clients and CORS

A browser sends a CORS preflight before each request with an `Authorization` header. `onRequest` answers it only when `httpsOptions.cors` is set. Set it to your web origins:

```ts
export const assistantAgent = onAgentRequest(assistant, {
  httpsOptions: {
    cors: ['https://app.example.com', /^https:\/\/[a-z0-9-]+\.example\.com$/],
  },
});
```

> **Note:** the Functions emulator turns CORS on for every function. A browser client can work locally and then fail in production with a CORS error. Set `cors` before you deploy.

### What it does

- **Authentication.** Every route needs a valid Firebase Auth ID token. A missing token gets 401, an invalid token gets 403. Set `enforceAppCheck: true` to also require App Check. It also takes a boolean params expression (for example `defineBoolean('ENFORCE_APP_CHECK')`), which is read on each request.
- **Per-user sessions.** `createUserScopedStore()` keeps snapshots in Firestore at `genkit-agent-sessions/<sha256(uid)>/...`. A user cannot read or resume another user's session. Give the agent this store, or another store that scopes snapshots by `context.auth.uid`. The library reads sessions through the agent's own store, so it cannot check this for you.
- **One turn at a time.** A Firestore lease lock (`genkit-agent-locks`) serializes the turns of each session. A second turn on a busy session gets 409 `ABORTED`. A turn that starts a new session (no `sessionId` or `snapshotId`) takes no lock.
- **Lease length.** The lease is the function's timeout plus 30 seconds. The timeout is `httpsOptions.timeoutSeconds`, else the `timeoutSeconds` from `setGlobalOptions`, else 60 seconds. A params expression (for example `defineInt('TIMEOUT')`) is read on each request. A value that is unset, zero or negative gives 60 seconds. Only a `setGlobalOptions` call that runs before `onAgentRequest` counts, the same rule firebase-functions uses for the deployed timeout.
- **Turning the lock off.** Set `lock: false` only when turns on one session never overlap, for example when your only client waits for each reply before it sends the next message. Without the lock, two turns on one session can run at the same time on the same history. You can also pass your own `TurnLock`.
- **Routes.** It serves the main route plus `/getSnapshot`, `/waitForSnapshot` and `/abort`, the same routes `remoteAgent` uses.
- **`authorize` hook.** This runs on every route after authentication and App Check. It gets the route (`turn`, `getSnapshot`, `waitForSnapshot` or `abort`) and the context, where `context.auth.uid` is a string and `context.auth.token` holds the decoded ID token.
- **`beforeTurn` hook.** This runs on each turn after `authorize` and before the lock. It gets the context and the parsed turn `input` and `init`. A turn body that is not a valid agent input or init gets 400 `INVALID_ARGUMENT` before the hook runs.
- **Hook errors.** If a hook throws a `GenkitError`, the request is rejected with that status. Any other error is logged and answers 500 `INTERNAL`.

```ts
import { GenkitError } from 'genkit';

export const assistantAgent = onAgentRequest(assistant, {
  // Protects every route, including /getSnapshot and /abort.
  authorize: ({ context }) => {
    if (context.auth.token.plan !== 'pro') {
      throw new GenkitError({
        status: 'PERMISSION_DENIED',
        message: 'Pro only.',
      });
    }
  },
  beforeTurn: ({ input }) => {
    if (input.message?.content.some((part) => part.media)) {
      throw new GenkitError({
        status: 'INVALID_ARGUMENT',
        message: 'Send text only.',
      });
    }
  },
});
```

### Limits

- **No detached turns.** Cloud Functions throttles CPU after the response is sent, so a detached turn cannot finish reliably. A request with `detach: true` gets 400 `FAILED_PRECONDITION`.
- **Denied reads return 500.** When a user asks for a snapshot that is not theirs, `@genkit-ai/express` returns 500 for the `NOT_FOUND` error. This comes from upstream.
- **No session list.** Session documents sit under the sha256 hash of the uid, and there is no route that lists them. Clients must keep their own session ids.
- **No cleanup.** Snapshots stay in Firestore until you delete them. The library sets no TTL.

### Local development

Run the Functions, Firestore and Auth emulators:

```sh
firebase emulators:start --only functions,firestore,auth
```

The function URL has this shape:

```
http://127.0.0.1:5001/<project>/<region>/<export name>
```

For example `http://127.0.0.1:5001/demo-test/us-central1/assistantAgent`.

Get an ID token from the Auth emulator. The emulator accepts any API key:

```sh
curl -s -X POST \
  'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key' \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"password123","returnSecureToken":true}'
```

The `idToken` field of the response is the bearer token. In a web app, call `connectAuthEmulator(auth, 'http://127.0.0.1:9099')` and use `getIdToken()` as in production.

The token setup is automatic. The Functions emulator turns on a debug mode that skips token verification, and that mode rejects the unsigned tokens of the Auth emulator. When `FUNCTIONS_EMULATOR` is `true` and `FIREBASE_AUTH_EMULATOR_HOST` is set, the library turns the skip off, so tokens are verified against the Auth emulator. The Functions emulator sets both variables when the Auth emulator runs.

The skip covers App Check tokens too. So with `enforceAppCheck: true`, the emulator verifies App Check tokens for real. Use a real project and the App Check debug provider. A `demo-` project fails with `Invalid AppCheck token`.

## Client

The client is the stock `remoteAgent` from `genkit/beta/client`. Create it with a `headers` function as shown in [Usage](#usage).

### Resume a session

Sessions cannot be listed (see [Limits](#limits)), so keep the session id on the client, for example in `localStorage`:

```ts
const chat = agent.chat();
await chat.send('Hello');
localStorage.setItem('sessionId', chat.sessionId!);

// Later, or after a page reload:
const resumed = await agent.loadChat({
  sessionId: localStorage.getItem('sessionId')!,
});
await resumed.send('What did I say before?');
```

`loadChat({ sessionId })` loads the latest snapshot of the session. `loadChat({ snapshotId })` loads one exact snapshot.

### Stream a reply

```ts
const turn = chat.sendStream('Tell me a story.');
for await (const chunk of turn.stream) {
  render(chunk.text);
}
const response = await turn.response;
```

### Interrupts

A turn that stops on an interrupt (`ai.defineInterrupt`, or `defineKitInterrupt` in the kit) resolves with `finishReason: 'interrupted'`. Build a response with `respond` and send it with `chat.resume`:

```ts
const response = await chat.send('Transfer 500 to Alice.');
if (response.finishReason === 'interrupted') {
  const approval = response.interrupts.find(
    (i) => i.name === 'approveTransfer',
  );
  if (approval) {
    await chat.resume({ respond: [approval.respond({ approved: true })] });
  }
}
```

### Errors

A failed turn rejects with an `AgentError`. When another turn holds the session, the server answers 409 `ABORTED`. The client does not map HTTP errors to a status, so check the message. Then wait, reload the chat and send again:

```ts
import { AgentError } from 'genkit/beta/client';

try {
  await chat.send(text);
} catch (err) {
  if (
    err instanceof AgentError &&
    err.message.startsWith('Server returned: 409:')
  ) {
    const fresh = await agent.loadChat({ sessionId: chat.sessionId! });
    await fresh.send(text); // after a short wait
  } else {
    throw err;
  }
}
```

## Terminal client

`genkit-agent-chat` is a chat client for the terminal. It talks to an agent served by `onAgentRequest` or by a kit instance. It uses the stock `remoteAgent` client, so it shows how a client handles streaming, interrupts, sessions and errors. The published package is one bundled file with no dependencies.

### Run it

The package is not published yet. Build it in this repo, then run the `bin`:

```sh
pnpm install && pnpm build
alias genkit-agent-chat="node $PWD/packages/cli/lib/bin.js"
```

In a Firebase project directory with a kit instance, no URL is needed:

```sh
genkit-agent-chat --email you@example.com          # the only instance, or a picker
genkit-agent-chat support --email you@example.com  # a named instance
genkit-agent-chat                                  # reconnect to the last agent
```

The client finds `firebase.json` in the current directory or above it. It reads the project from `.firebaserc` (the `default` alias, or `--project`), the instances from the `instances` map of the kit config, and the region from `FUNCTION_DEFAULT_REGION` in the instance's `.env`, `.env.<projectId>` and `.env.<alias>` files (later files win; the default is `us-central1`). It then calls `https://<region>-<project>.cloudfunctions.net/kit-<instance>-agent`.

Outside a project directory, name the instance and the project, or pass the URL:

```sh
genkit-agent-chat support --project my-project --region europe-west1 --email you@example.com
genkit-agent-chat --url https://<region>-<project>.cloudfunctions.net/<function> \
  --api-key <firebase web api key> --email you@example.com
```

| Option               | Environment variable | What it does                                             |
| -------------------- | -------------------- | -------------------------------------------------------- |
| `[instance]`         |                      | The kit instance id.                                     |
| `--project <id>`     |                      | The project id or `.firebaserc` alias.                   |
| `--region <region>`  |                      | The region of the instance's function.                   |
| `--url <url>`        | `GENKIT_AGENT_URL`   | The agent function URL. It overrides the options above.  |
| `--api-key <key>`    | `FIREBASE_API_KEY`   | The Firebase web API key. It overrides the lookup below. |
| `--email <email>`    |                      | Sign in with email and password.                         |
| `--id-token <token>` | `FIREBASE_ID_TOKEN`  | Use this ID token. It is not refreshed.                  |
| `--resume [id]`      |                      | Resume a session. Without an id, the last one.           |
| `--logout`           |                      | Forget the saved sign-in for the API key and email.      |

Prefer the `FIREBASE_ID_TOKEN` environment variable to `--id-token`: other users can see command line arguments in `ps`, and the shell keeps them in its history. An explicit `--email` wins over `FIREBASE_ID_TOKEN`.

### API key

With a project, the client looks up the web API key through the Firebase Management API. It uses your Application Default Credentials (`gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`). When all web apps of the project use the same key, it uses that key; otherwise it asks which app. Without credentials, it asks for the key once. It caches the key per project in `state.json`. The key is public configuration, not a secret.

### Sign-in

The first run asks for the password. The client signs in with the Identity Toolkit REST API and keeps the refresh token in `credentials.json` in its config directory (`$XDG_CONFIG_HOME/genkit-agent-chat`, or `~/Library/Application Support/genkit-agent-chat` on macOS, `~/.config/genkit-agent-chat` on Linux). The files have mode 0600. The password is not saved. Later runs refresh the ID token before it expires and do not ask again. `--logout` deletes the saved refresh token. Set `FIREBASE_AUTH_EMULATOR_HOST` to sign in against the Auth emulator; emulator sign-ins are kept apart from production ones, and the header shows the emulator.

### In the chat

| Input          | What it does                                       |
| -------------- | -------------------------------------------------- |
| `/new`         | Start a new session.                               |
| `/resume <id>` | Switch to an existing session.                     |
| `/session`     | Show the current session id.                       |
| `/help`        | Show the commands.                                 |
| `/quit`        | Exit. `/exit` and Ctrl+C at the prompt also exit.  |
| `//text`       | Send a message that starts with `/`.               |
| Ctrl+C         | During a reply: stop the stream on this side only. |

- **Interrupts.** A turn that stops on an interrupt shows an approval card with the tool name and its input. `a` sends `{"approved": true}`, `d` sends `{"approved": false}`, and `e` lets you type any JSON response. The client cannot see the output schema of the interrupt, so pick `e` when the tool expects something else. Esc leaves the card; `/resume <id>` shows it again.
- **409.** When another turn holds the session, the client says so. Press `r` to reload the session and send again, or Esc to get the message back in the prompt.
- **Colours.** Set `NO_COLOR` to turn colours off; bold, dim and the cursor stay. When stdin or stdout is not a terminal, the client reads one message per line, prints plain text, and writes problems to stderr. An interrupt then reads `approve`, `deny` or a JSON value from the next line. The exit code is 1 when a turn failed.

### Editing keys

The prompt and the input fields use readline keys:

| Keys                                   | What they do                             |
| -------------------------------------- | ---------------------------------------- |
| Ctrl+A / Ctrl+E, Home / End            | Go to the start or the end.              |
| Option+Left / Option+Right, Ctrl+B / F | Move by a word or a character.           |
| Ctrl+U, Cmd+Backspace                  | Delete to the start.                     |
| Ctrl+K                                 | Delete to the end.                       |
| Option+Backspace                       | Delete the previous word.                |
| Ctrl+W                                 | Delete the previous word, up to a space. |
| Delete (forward delete)                | Delete the next character.               |

Terminals send different bytes for some keys. Cmd+Backspace works where the terminal sends Ctrl+U for it: iTerm2, the VS Code terminal and Ghostty do this by default; Terminal.app sends nothing. Option+Backspace and Option+Left/Right need the Option key to act as Meta: turn on "Use Option as Meta key" in Terminal.app, or set the Option key to "Esc+" in iTerm2. Shift+Backspace sends the same byte as Backspace in all four.

## Function Kit

A kit instance is one agent. Its prompt file sets the model, the tools and the system prompt. You define the tools in your own code.

### Quick start

These steps are checked against firebase-tools 15.36.0, the version this repo pins. The `functions:kits:install` command first shipped in 15.27.0. Older versions can behave differently.

1. **Get the CLI.** Install firebase-tools 15.36.0 or later and sign in with `firebase login`. Run the commands below in a Firebase project directory (one with a `firebase.json`). The `kits` experiment is on by default in 15.36.0. If the CLI says it is off, run `firebase experiments:enable kits`.

2. **Install the kit.**

   ```sh
   firebase functions:kits:install --package genkit-agent-kit
   ```

   - `--package` takes an npm registry name, with an optional version (`genkit-agent-kit@1.2.3`). The CLI rejects paths, git URLs and tarballs. Before the package is on npm, point npm at a registry that has it. The CLI runs `npm install` in `function-kits/genkit-agent-kit/source`, so an `.npmrc` in the project root is not read. Set the registry in your user config (`npm config set registry <url>`, which writes `~/.npmrc`) or in the `NPM_CONFIG_REGISTRY` environment variable. `--directory <path>` installs a local functions codebase instead; this README does not cover it.
   - The CLI asks you to confirm, because the package is outside the `@firebase-function-kits` scope. It installs the package with `--ignore-scripts`.
   - The CLI asks for the kit name and the instance name. Both default to `genkit-agent-kit`. This README assumes the default kit name. Instance names are up to 40 characters of lowercase letters, digits, `_` and `-`, and cannot start or end with `-`.
   - The CLI asks for a region, because the generated wrapper defines a `FUNCTION_DEFAULT_REGION` param. Then it asks for the [kit params](#kit-params). It writes the answers to `function-kits/genkit-agent-kit/config-<instance>/.env.<projectId>`. `--no-configure` skips these questions. Then write that file yourself, with a value for every param.
   - The CLI runs without prompts when it detects an AI agent, when stdin is not a terminal, or with `--non-interactive`. Then the kit and the instance get the default names, and the install fails on the confirmation and on the param questions. Pass `--force --no-configure`, then write `config-<instance>/.env.<projectId>` as shown in [Kit params](#kit-params). Or pass `--interactive` to keep the prompts.

3. **Check `firebase.json`.** The install adds a kit stanza like this one:

   ```json
   {
     "functions": [
       {
         "kit": "genkit-agent-kit",
         "sourcePackage": { "name": "genkit-agent-kit" },
         "source": "function-kits/genkit-agent-kit/source",
         "instances": {
           "support": "function-kits/genkit-agent-kit/config-support"
         },
         "predeploy": ["npm --prefix \"$RESOURCE_DIR\" run build"]
       }
     ]
   }
   ```

4. **Create the prompt.** The install does not create it. Add `function-kits/genkit-agent-kit/source/prompts/<instance>.prompt`, for example `prompts/support.prompt`:

   ```
   ---
   model: vertexai/gemini-2.5-flash
   ---
   {{role "system"}}
   You are the support agent for our app. Answer briefly and politely.
   ```

   Without this file, every request gets 400 `FAILED_PRECONDITION` and the function log names the missing file.

5. **Run it locally.** Model calls go to Vertex AI, so use a real project (not a `demo-` project) with the Vertex AI API on, and Application Default Credentials:

   ```sh
   gcloud auth application-default login
   firebase emulators:start --only functions,firestore,auth --project <project>
   ```

   The instance URL is:

   ```
   http://127.0.0.1:5001/<project>/<region>/kit-<instance>-agent
   ```

   Get a token from the Auth emulator as in [Local development](#local-development).

6. **Deploy.** Run `firebase deploy --only functions`. The production URL is:

   ```
   https://<region>-<project>.cloudfunctions.net/kit-<instance>-agent
   ```

7. **Call it.** Use the client from [Usage](#usage) with the instance URL:

   ```ts
   const agent = remoteAgent({
     url: 'https://<region>-<project>.cloudfunctions.net/kit-support-agent',
     headers: async () => ({
       Authorization: `Bearer ${await auth.currentUser!.getIdToken()}`,
     }),
   });
   const reply = await agent.chat().send('Hello');
   ```

   For a browser client, set the `CORS_ORIGINS` param of the instance to your web origins (see [Kit params](#kit-params)) and deploy again. With an empty `CORS_ORIGINS`, the function sends no CORS headers and the browser blocks the call. Server clients do not need CORS.

**Add a second instance.** Run `firebase functions:kits:install --package genkit-agent-kit` again. The CLI finds the installed kit and asks for the new instance name. Then add `prompts/<new instance>.prompt`.

**Upgrade the kit.** Run `npm install genkit-agent-kit@<version>` in `function-kits/genkit-agent-kit/source`.

### Kit params

Each instance has its own values for these params:

| Param               | Type            | Default       | Effect                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGINS`      | list of strings | empty         | The web origins that can call the instance from a browser. This is the `cors` option of the function. Empty means no CORS headers, so browsers cannot call.                                                                                                                                                                                                   |
| `TIMEOUT_SECONDS`   | integer, 1-3600 | `60`          | The function timeout. The turn lock lease is this value plus 30 seconds.                                                                                                                                                                                                                                                                                      |
| `MEMORY`            | integer, in MiB | `256`         | The function memory. The CLI offers 256, 512, 1024, 2048 and 4096.                                                                                                                                                                                                                                                                                            |
| `ENFORCE_APP_CHECK` | boolean         | `false`       | Exactly `true` or `false`. When `true`, every request also needs a valid App Check token in the `X-Firebase-AppCheck` header. A request without one gets 403 `PERMISSION_DENIED`. Any other value (for example `TRUE` or `yes`) is a configuration problem: every request gets 400 `FAILED_PRECONDITION` (see [Configuration checks](#configuration-checks)). |
| `VERTEX_LOCATION`   | string          | `us-central1` | The Vertex AI location for model calls. It can differ from the function region. Use `global` for models that only the global endpoint serves.                                                                                                                                                                                                                 |

**Where to set them.** `firebase functions:kits:install` asks for each value and writes it to `function-kits/genkit-agent-kit/config-<instance>/.env.<projectId>`. To change a value later, edit that file and deploy again. A full file looks like this:

```
FUNCTION_DEFAULT_REGION=us-central1
CORS_ORIGINS=["https://app.example.com","http://localhost:5173"]
TIMEOUT_SECONDS=120
MEMORY=512
ENFORCE_APP_CHECK=false
VERTEX_LOCATION=us-central1
```

When the file has no value for a param, an interactive `firebase deploy` asks for it. A non-interactive deploy fails and does not use the default. The CLI is non-interactive when stdin is not a terminal, with `--non-interactive`, or when it detects an AI agent. The emulator asks for the value in a terminal and uses the default without one. It writes the value to `config-<instance>/.env.local`.

**`CORS_ORIGINS` format.** Write the list as JSON, as in the file above. The install prompt takes a comma-separated list and writes it to the file without brackets (`CORS_ORIGINS=https://app.example.com,http://localhost:5173`). A deploy reads both forms, but the Functions emulator reads only the JSON form. With the comma form, the instance sends no CORS headers in the emulator. To allow no browser origin, leave the value empty (`CORS_ORIGINS=`).

An empty list makes firebase-functions log a warning on every request, except in one case:

- `CORS_ORIGINS=[]` in production logs `CORS parameter resolved to an empty array. Disabling CORS.`
- `CORS_ORIGINS=` in the emulator logs `Failed to resolve CORS parameter`.
- `CORS_ORIGINS=` in production logs nothing.

> **Note:** when `CORS_ORIGINS` is not empty, the Functions emulator answers a preflight from any origin. Only a deployed function checks the origin against the list.

**`TIMEOUT_SECONDS` and `MEMORY`** are set on the kit's function, so the `timeoutSeconds` and `memory` of a `setGlobalOptions` call in the wrapper do not apply to it.

**`ENFORCE_APP_CHECK`** works in the emulator only with a real project and the App Check debug provider. See [Local development](#local-development).

### Layout after `firebase functions:kits:install`

```
function-kits/genkit-agent-kit/
  source/
    src/index.ts            your wrapper: re-exports the kit, and you define tools here
    prompts/support.prompt  one prompt per instance, named after the instance id (you create these)
    prompts/sales.prompt
  config-support/.env.<projectId>
  config-sales/.env.<projectId>
```

### Prompt file

`prompts/<instance id>.prompt`:

```
---
model: vertexai/gemini-2.5-flash
tools: [lookupOrder]
---
{{role "system"}}
You are the support agent. Use lookupOrder to answer questions about orders.
```

### Your tools

Add tools to `source/src/index.ts`, below the generated `setGlobalOptions({ region: regionParam })` call. This includes the `import` line. The wrapper compiles to CommonJS, where each `import` runs at its place in the file. If `genkit-agent-kit` loads before `setGlobalOptions` runs, the kit's function gets no region and deploys to the default region (`us-central1`). Below that call, the tool definitions can come before or after the `export * from 'genkit-agent-kit'` line. You can also put the tools in their own file and import that file below the call.

```ts
// ...generated code, ending with setGlobalOptions({ region: regionParam });

import { defineKitTool, z } from 'genkit-agent-kit';

defineKitTool(
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
export * from 'genkit-agent-kit';
```

Each instance deploys a function named `kit-<instance id>-agent`. The kit exports this function as `agent`, so do not export anything else named `agent` from the wrapper. A local export with that name silently replaces the kit's function.

A tool fails with `UNAUTHENTICATED` when it runs without a signed-in caller, for example from the Genkit Developer UI without an auth context.

**Interrupts.** Use `defineKitInterrupt` to ask the user before a tool writes or spends. It takes the same arguments as Genkit's `ai.defineInterrupt`. Name it in the `tools:` list of the prompt like any tool. The client answers with `chat.resume({ respond })`, as shown in [Interrupts](#interrupts). The response comes from the client, so the server does not verify it.

```ts
import { defineKitInterrupt, z } from 'genkit-agent-kit';

defineKitInterrupt({
  name: 'approveRefund',
  description: 'Ask the user to approve a refund.',
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  outputSchema: z.object({ approved: z.boolean() }),
});
```

**Models.** `defineKitModel` registers a model that a prompt can name in its `model:` frontmatter, for example a model served by your own backend or a scripted model for tests. It takes the same arguments as Genkit's `ai.defineModel`.

Every instance runs the whole wrapper, so every tool you define is registered in every instance. Only the `tools:` list in the prompt of an instance decides which tools its model can call. If the model asks for a tool that the list does not name, the turn fails: `chat.send` rejects with an `AgentError` with status `NOT_FOUND` and the message `Tool <name> not found`.

### Configuration checks

The kit checks two things: that `prompts/<instance id>.prompt` exists, and that every name in its `tools:` list is defined. If a check fails, the kit logs the details with the `firebase-functions` logger.

It also checks that `ENFORCE_APP_CHECK` is exactly `true` or `false`. firebase-functions reads any other value as `false`, which would turn App Check off without a sign.

- **At cold start.** When an instance starts, the kit runs the check once in the background and logs any problem. A failed check does not stop the instance. The check does not run during deploy discovery.
- **On each request.** Until the check passes, every request runs it again, on every route. A failed check answers 400 `FAILED_PRECONDITION`. Without the check, Genkit would return HTTP 200 with a failed turn and log nothing, and with an invalid `ENFORCE_APP_CHECK` the `/getSnapshot`, `/waitForSnapshot` and `/abort` routes would run without App Check.

In production, the 400 message only says that the instance is misconfigured. In the Functions emulator, the message holds the details:

```json
{
  "status": "FAILED_PRECONDITION",
  "message": "Agent kit instance \"support\" lists tools that are not defined: lookupOrdr. Fix the tools: list in prompts/support.prompt or define the tools with defineKitTool."
}
```

### Model access

The kit uses the Vertex AI plugin with Application Default Credentials, so it needs no API key. Model calls go to the location in the `VERTEX_LOCATION` param (see [Kit params](#kit-params)). The default is `us-central1` for every function region, so a function in an EU region still sends model traffic to `us-central1` until you change `VERTEX_LOCATION`. It declares the `aiplatform.googleapis.com` and `firestore.googleapis.com` APIs and the `roles/aiplatform.user` and `roles/datastore.user` roles.

## Security

> **Warning:** tools run as the function's service account, which has Admin SDK access. They bypass Firestore security rules.

- Build data paths from `context.auth.uid`. Never build them from model output alone.
- Keep tool input schemas narrow.
- Use an interrupt (`ai.defineInterrupt`, or `defineKitInterrupt` in the kit) to get user approval before a tool writes or spends.
- Keep the `genkit-agent-sessions` and `genkit-agent-locks` collections closed to client SDKs. Your Firestore rules must deny all reads and writes there. Only the function, through the Admin SDK, may touch them. For example:

  ```
  match /genkit-agent-sessions/{document=**} {
    allow read, write: if false;
  }
  match /genkit-agent-locks/{document=**} {
    allow read, write: if false;
  }
  ```

## Development

```sh
pnpm install
pnpm lint            # Biome
pnpm typecheck
pnpm test            # unit tests
pnpm test:emulator   # library, against the Functions, Firestore and Auth emulators (needs Java 21)
pnpm test:kit        # kit instances, against the emulators
pnpm test:cli        # terminal client, against the emulators
```

The emulator tests use a scripted fake model, so they need no Google Cloud project.

## License

Apache-2.0
