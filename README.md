# genkit-agent-functions

Serve [Genkit](https://genkit.dev) agents from Firebase Cloud Functions, with per-user sessions and one turn at a time per session.

This repo has two packages:

| Package | What it is |
|---|---|
| `genkit-agent-functions` (repo root) | A library. `onAgentRequest(agent, options)` turns a Genkit agent into an HTTPS function that the stock `remoteAgent` client can talk to. |
| `genkit-agent-kit` (`packages/agent-kit`) | A Firebase Function Kit built on the library. Each kit instance is an agent defined by a `.prompt` file, with tools you write yourself. |

> **Status:** pre-release. The packages are not published to npm yet, and the names may change. It requires Genkit 1.44 (beta agents API) and Node.js 22.12 or later.

## Library

### Usage

```ts
import { initializeApp } from 'firebase-admin/app';
import { genkit } from 'genkit/beta';
import { vertexAI } from '@genkit-ai/google-genai';
import { createUserScopedStore, onAgentRequest } from 'genkit-agent-functions';

initializeApp();

const ai = genkit({ plugins: [vertexAI()] });
const store = createUserScopedStore();

const assistant = ai.defineAgent({
  name: 'assistant',
  model: 'vertexai/gemini-2.5-flash',
  system: 'You are a helpful assistant.',
  store,
});

export const assistantAgent = onAgentRequest(assistant, {
  store, // the same instance as the agent's store
  httpsOptions: { timeoutSeconds: 120 },
});
```

On the client:

```ts
import { remoteAgent } from 'genkit/beta/client';

const agent = remoteAgent({
  url: 'https://<region>-<project>.cloudfunctions.net/assistantAgent',
  headers: { Authorization: `Bearer ${await user.getIdToken()}` },
});
const chat = agent.chat();
const reply = await chat.send('Hello');
```

### What it does

- **Authentication.** Every route needs a valid Firebase Auth ID token. A missing token gets 401, an invalid token gets 403. Set `enforceAppCheck: true` to also require App Check.
- **Per-user sessions.** `createUserScopedStore()` keeps snapshots in Firestore at `genkit-agent-sessions/<sha256(uid)>/...`. A user cannot read or resume another user's session.
- **One turn at a time.** A Firestore lease lock (`genkit-agent-locks`) serializes the turns of each session. A second turn on a busy session gets 409 `ABORTED`. The lease is `timeoutSeconds` plus 30 seconds. Set `lock: false` to turn this off, or pass your own `TurnLock`.
- **Routes.** It serves the main route plus `/getSnapshot`, `/waitForSnapshot` and `/abort`, the same routes `remoteAgent` uses.
- **`beforeTurn` hook.** This runs on each turn after authentication and before the lock. If it throws a `GenkitError`, the turn is rejected with that status.

### Limits

- **No detached turns.** Cloud Functions throttles CPU after the response is sent, so a detached turn cannot finish reliably. A request with `detach: true` gets 400 `FAILED_PRECONDITION`.
- **Denied reads return 500.** When a user asks for a snapshot that is not theirs, `@genkit-ai/express` returns 500 for the `NOT_FOUND` error. This comes from upstream.

## Function Kit

A kit instance is one agent. Its prompt file sets the model, the tools and the system prompt. You define the tools in your own code.

### Layout after `firebase functions:kits:install`

```
function-kits/genkit-agent-kit/
  source/
    src/index.ts            your wrapper: define tools, then re-export the kit
    prompts/support.prompt  one prompt per instance, named after the instance id
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

`source/src/index.ts`:

```ts
import { defineKitTool, z } from 'genkit-agent-kit';

defineKitTool(
  {
    name: 'lookupOrder',
    description: 'Look up one of the caller\'s orders.',
    inputSchema: z.object({ orderId: z.string() }),
  },
  async ({ orderId }, { context }) => {
    const uid = context.auth?.uid; // the signed-in caller
    // ...read only data that belongs to uid
  },
);

export * from 'genkit-agent-kit';
```

Each instance deploys a function named `kit-<instance id>-agent`.

### Configuration checks

On the first turn, the kit checks two things: that `prompts/<instance id>.prompt` exists, and that every name in its `tools:` list is defined. If a check fails, the kit logs the details with the `firebase-functions` logger and answers 400 `FAILED_PRECONDITION`. Without the check, Genkit would return HTTP 200 with a failed turn and log nothing.

### Model access

The kit uses the Vertex AI plugin with Application Default Credentials, so it needs no API key. It declares the `aiplatform.googleapis.com` and `firestore.googleapis.com` APIs and the `roles/aiplatform.user` and `roles/datastore.user` roles.

## Security

> **Warning:** tools run as the function's service account, which has Admin SDK access. They bypass Firestore security rules.

- Build data paths from `context.auth.uid`. Never build them from model output alone.
- Keep tool input schemas narrow.
- Use an interrupt (`ai.defineInterrupt`) to get user approval before a tool writes or spends.

## Development

```sh
pnpm install
pnpm lint            # Biome
pnpm typecheck
pnpm test            # unit tests
pnpm test:emulator   # library, against the Functions, Firestore and Auth emulators (needs Java 21)
pnpm test:kit        # kit instances, against the emulators
```

The emulator tests use a scripted fake model, so they need no Google Cloud project.

## License

Apache-2.0
