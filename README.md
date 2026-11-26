# Firebase Agent Kit

> **Status:** experimental. This is a personal demo and a community project, not an official Firebase or Genkit project, and it is not supported for production use. APIs, package names and behavior may change without notice.
>
> It is pre-release. The packages are not published to npm yet, and the names may change. It requires Genkit 1.44 (beta agents API) and Node.js 22.12 or later.

Serve a multi-user [Genkit](https://genkit.dev) agent from Firebase Cloud Functions. `@cabljac/firebase-agent-kit` is a Firebase Function Kit: you install it into your project, write a `.prompt` file, and deploy. Each kit instance is one agent with its own prompt, tools and settings.

What you get on every instance:

- **Auth on every route.** Every route needs a Firebase Auth ID token, including the snapshot and abort routes. App Check is one param away.
- **Per-user sessions.** Sessions live in Firestore, keyed by the user. One user cannot read, resume or abort the session of another user.
- **One turn at a time.** A per-session lock gives a second, concurrent turn a clean 409 instead of a race on the same history.
- **Streaming and interrupts.** The stock `remoteAgent` client streams replies and answers tool approvals.
- **Gemini on Vertex AI with no API key.** Model calls use the function's service account.
- **Configuration checks.** A missing prompt file, a typo in its `tools:` list or a bad param value gets a clear error and a log entry, not a silent failed turn.
- **Per-instance params.** CORS origins, timeout, memory, App Check and the Vertex AI location, set per instance.

## Quick start

Run this in a Firebase project directory, with firebase-tools 15.27.0 or later:

```sh
firebase functions:kits:install --package @cabljac/firebase-agent-kit
```

The CLI asks for an instance name (for example `support`), a region and the params. It installs the kit in `function-kits/firebase-agent-kit/source` and adds a kit stanza to `firebase.json`. See [Install](packages/agent-kit/README.md#install) for the non-interactive flags and for a manual install.

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

Define the tools in the wrapper, `source/src/index.ts`, below the generated `setGlobalOptions` call. `ai` is the kit's Genkit instance. `ai.defineTool` gives the tool the signed-in caller, and a call without one fails with `UNAUTHENTICATED`:

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

export * from '@cabljac/firebase-agent-kit';
```

Change the params in `function-kits/firebase-agent-kit/config-support/.env.<projectId>`. See [Customise](packages/agent-kit/README.md#customise) and [Configuration](packages/agent-kit/README.md#configuration).

## Deploy

```sh
firebase deploy --only functions:support
```

The filter is the instance id, not the function name `kit-support-agent`. A non-interactive first deploy needs `--force` to confirm the service account that the deploy creates. See [Required IAM](packages/agent-kit/README.md#required-iam). The function URL is `https://<region>-<project>.cloudfunctions.net/kit-support-agent`.

## Chat

From the terminal, with [`fak`](packages/cli/README.md), in the project directory:

```sh
npx @cabljac/firebase-agent-kit-cli support --email you@example.com
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

For a browser client, set the `CORS_ORIGINS` param of the instance. Before you go live, close the session collections in your Firestore rules: see [Security](packages/agent-kit/README.md#security).

## Packages

| Package                                                       | What it is                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`@cabljac/firebase-agent-kit`](packages/agent-kit/README.md) | The Function Kit. Each instance serves a prompt agent with your tools.                                      |
| [`@cabljac/firebase-agent-kit-core`](packages/core/README.md) | The library under the kit. `onAgentRequest(agent, options)` serves any Genkit agent from an HTTPS function. |
| [`@cabljac/firebase-agent-kit-cli`](packages/cli/README.md)   | `fak`, a terminal chat client for kit instances and `onAgentRequest` functions.                             |

## Development

```sh
pnpm install
pnpm build
pnpm lint            # Biome
pnpm typecheck
pnpm test            # unit tests of all packages
pnpm test:emulator   # core, against the Functions, Firestore and Auth emulators (needs Java 21)
pnpm test:kit        # kit instances, against the emulators
pnpm test:cli        # terminal client, against the emulators
```

The emulator tests use a scripted fake model, so they need no Google Cloud project.

## License

Apache-2.0
