# Firebase Agent Kit

Serve a multi-user [Genkit](https://genkit.dev) agent from Firebase Cloud Functions. Write a `.prompt` file and your tools, install the kit, and deploy. Each signed-in user gets their own sessions.

> **Status:** experimental community project. It is not an official Firebase or Genkit project, and it is not for production use. The packages are not on npm yet, so the install needs [one extra step](#quick-start). APIs and package names may change. It requires Genkit 1.44 (beta agents API), Node.js 22.12 or later and firebase-tools 15.27.0 or later (checked against 15.36.0).

## Why this exists

Genkit 1.44 adds agents. `expressHandler(agent)` from `@genkit-ai/express` serves the turn route of an agent from an `onRequest` function. A multi-user deployment needs more: the snapshot and abort routes behind the same auth, sessions scoped to each user, and one turn at a time per session. This project adds those parts. It ships them as a Firebase Function Kit (`@cabljac/firebase-agent-kit`) that `firebase functions:kits:install` installs.

```
client (remoteAgent or fak)
  -> kit-<instance>-agent         onAgentRequest (core library): auth, sessions, turn lock
       -> Firestore               sessions, locks and detached runs
       -> Cloud Tasks (optional)  detached turns
            -> kit-<instance>-agentWorker
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how a turn, the turn lock and detached turns work.

## What you get

Each kit instance is one agent with its own prompt, tools and params.

**Built for many users**

- **Auth on every route.** Every route needs a Firebase Auth ID token, including the snapshot and abort routes. Set the `ENFORCE_APP_CHECK` param to also require App Check.
- **Per-user sessions.** Sessions live in Firestore, keyed by the instance and the user. One user cannot read, resume or abort the session of another user, and one instance cannot load the session of another instance.
- **One turn at a time.** A per-session turn lock gives a second, concurrent turn 409 `ABORTED`. Two turns do not race on one session history.

**Agent features from the prompt file**

- **Streaming and interrupts.** The stock `remoteAgent` client streams replies and answers tool approvals. You need no custom client.
- **Skills, retry and fallback.** Name them in the `use:` list of the prompt.
- **Gemini on Vertex AI with no API key.** Model calls use the function's service account.

**Firebase-native operations**

- **Installed by firebase-tools.** `firebase functions:kits:install` adds an instance. Params set CORS origins, timeout, memory, App Check and the Vertex AI location per instance.
- **Detached turns (experimental, off by default).** Set the `DETACHED_TURNS` param, then send a turn with `detach: true`. It runs through Cloud Tasks, so it can run longer than the HTTP request.
- **Clear configuration errors.** A missing prompt file, a typo in the `tools:` list or a bad value in a checked param fails the configuration checks. The request gets 400 `FAILED_PRECONDITION` and the function writes a log entry. Without the checks, Genkit returns HTTP 200 with a failed turn and logs nothing.
- **A terminal chat client.** `fak` signs in to a deployed instance and chats with it. The Genkit CLI has no client for a deployed, authenticated agent.

## Packages

| Package                                                       | What it is                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`@cabljac/firebase-agent-kit`](packages/agent-kit/README.md) | The Function Kit. Each instance serves a prompt agent with your tools.                                      |
| [`@cabljac/firebase-agent-kit-core`](packages/core/README.md) | The library under the kit. `onAgentRequest(agent, options)` serves any Genkit agent from an HTTPS function. |
| [`@cabljac/firebase-agent-kit-cli`](packages/cli/README.md)   | `fak`, a terminal chat client for kit instances and `onAgentRequest` functions.                             |

## Quick start

Run this in a Firebase project directory:

```sh
firebase functions:kits:install --package @cabljac/firebase-agent-kit
```

**Before the packages are on npm.** `kits:install` takes only an npm registry name. Point npm at a registry that has the package: run `npm config set registry <url>`, or set `NPM_CONFIG_REGISTRY`. A project `.npmrc` does not work, because firebase-tools runs `npm install` in `function-kits/firebase-agent-kit/source`. See [Install](packages/agent-kit/README.md#install).

firebase-tools asks for an instance name (for example `support`), a region and the params. It installs the kit in `function-kits/firebase-agent-kit/source` and adds a kit stanza to `firebase.json`. See [Install](packages/agent-kit/README.md#install) for the non-interactive flags and for a manual install.

For a full project that shows most features, see the [game master example](examples/README.md): two text adventure instances with per-user tools, server-side dice, a restartable approval, skills, retry and fallback, session resume and a detached turn.

## Customise

Create the prompt of the instance, `function-kits/firebase-agent-kit/source/prompts/support.prompt`:

```
---
model: vertexai/gemini-2.5-flash
tools: [lookupOrder]
---
{{role "system"}}
You are the support agent. Use lookupOrder to answer questions about orders.
```

Define the tools in `source/src/index.ts`, below the generated `setGlobalOptions` call. `ai` is the kit's Genkit instance. Each tool gets the signed-in caller in `context.auth`. A call with no signed-in caller fails with `UNAUTHENTICATED`:

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

export * from '@cabljac/firebase-agent-kit';
```

To give the agent skills, add `use: [skills]` to the prompt and put each skill in `source/skills/support/<skill name>/SKILL.md`. The model loads a skill only when it needs it. See [Skills](packages/agent-kit/README.md#skills).

For model calls, `use:` can also name `retry`, and `fallback` with a `models` list. See [Retry and fallback](packages/agent-kit/README.md#retry-and-fallback).

Change the params in `function-kits/firebase-agent-kit/config-support/.env.<projectId>`. See [Customise](packages/agent-kit/README.md#customise) and [Configuration](packages/agent-kit/README.md#configuration).

## Deploy

```sh
firebase deploy --only functions:support
```

Filter by the instance id, not the function name `kit-support-agent`.

A non-interactive first deploy needs `--force`. It confirms the service account that the deploy creates. See [Required IAM](packages/agent-kit/README.md#required-iam).

The function URL is `https://<region>-<project>.cloudfunctions.net/kit-support-agent`.

## Chat

From the terminal, with [`fak`](packages/cli/README.md). It finds the instance from `firebase.json` and `.firebaserc`, signs you in, streams replies and shows tool approvals as cards. Until the package is on npm, [build it from this repo](packages/cli/README.md#run-it) and alias it as `fak`. Then run it in the project directory:

```sh
fak support --email you@example.com
```

From an app, with the stock `remoteAgent` client:

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

For a browser client, set the `CORS_ORIGINS` param of the instance. Before real users sign in, close the session collections in your Firestore rules: see [Security](packages/agent-kit/README.md#security).

## Limits and feedback

For known limits, see [Limits](packages/agent-kit/README.md#limits) and [Upstream workarounds](packages/core/README.md#upstream-workarounds). To report a bug or give feedback, open an issue in the [issue tracker](https://github.com/cabljac/firebase-agent-kit/issues).

## Development

```sh
pnpm install
pnpm build
pnpm lint            # Biome
pnpm typecheck
pnpm test            # unit tests of all packages
pnpm test:emulator   # core, against the Functions, Firestore and Auth emulators (needs Java 21)
pnpm test:kit        # kit instances, against the emulators
pnpm test:cli        # fak, against the emulators
pnpm test:detach     # detached turns, against the emulators with Cloud Tasks, on offset ports
```

The emulator tests use a scripted fake model, so they need no Google Cloud project.

## License

Apache-2.0
