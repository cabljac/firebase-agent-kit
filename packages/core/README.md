# @cabljac/firebase-agent-kit-core

> **Status:** experimental and pre-release. This is a community project, not an official Firebase or Genkit project, and it is not supported for production use. It is not published to npm yet. APIs, package names and behavior may change without notice. It requires Genkit 1.44 (beta agents API) and Node.js 22.12 or later.

Serve [Genkit](https://genkit.dev) agents from Firebase Cloud Functions, with per-user sessions and one turn at a time per session. This is the library under [`@cabljac/firebase-agent-kit`](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/agent-kit#readme). Use it directly when you want to write the `onRequest` function yourself instead of installing the kit.

`expressHandler(agent)` from `@genkit-ai/express` can already serve an agent from an `onRequest` function. This library adds what a multi-user production deployment needs on top of that route:

- **Firebase Auth on every route.** The turn route and the `/getSnapshot`, `/waitForSnapshot` and `/abort` routes all need a valid ID token. App Check is optional.
- **A uid-scoped session store.** One user cannot read, resume or abort the session of another user.
- **A per-session turn lock.** Two concurrent turns on one session get a clean 409 instead of racing on the same history.
- **A detach guard.** Detached (background) turns cannot finish reliably on Cloud Functions, so the library rejects them.

## Usage

```ts
import { initializeApp } from 'firebase-admin/app';
import { genkit } from 'genkit/beta';
import { vertexAI } from '@genkit-ai/google-genai';
import {
  createUserScopedStore,
  onAgentRequest,
} from '@cabljac/firebase-agent-kit-core';

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

## Browser clients and CORS

A browser sends a CORS preflight before each request with an `Authorization` header. `onRequest` answers it only when `httpsOptions.cors` is set. Set it to your web origins:

```ts
export const assistantAgent = onAgentRequest(assistant, {
  httpsOptions: {
    cors: ['https://app.example.com', /^https:\/\/[a-z0-9-]+\.example\.com$/],
  },
});
```

The browser enforces the list. With one origin in the list, firebase-functions sends that origin in `Access-Control-Allow-Origin` to every caller, and a browser on another origin blocks the response. With two or more, it sends the header only to a listed origin.

> **Note:** the Functions emulator turns CORS on for every function. A browser client can work locally and then fail in production with a CORS error. Set `cors` before you deploy.

## What it does

- **Authentication.** Every route needs a valid Firebase Auth ID token. A missing token gets 401, an invalid token gets 403. Set `enforceAppCheck: true` to also require App Check. It also takes a boolean params expression (for example `defineBoolean('ENFORCE_APP_CHECK')`), which is read on each request.
- **Per-user sessions.** `createUserScopedStore()` writes three Firestore collections, each keyed by the user key: the sha256 hex of the JSON array `[scope, uid]`, with `null` when there is no scope. `agent-kit-sessions/<user key>/snapshots/...` holds the snapshots, `agent-kit-sessions-pointers/<user key>/pointers/...` holds one pointer document per session, and `agent-kit-sessions-shards/<user key>/shards/...` holds the sharded checkpoints, which contain the message history. With the `collection` option, the names are `<collection>`, `<collection>-pointers` and `<collection>-shards`. A user cannot read or resume another user's session. Give the agent this store, or another store that scopes snapshots by `context.auth.uid`. The library reads sessions through the agent's own store, so it cannot check this for you.
- **Session scope.** Without a scope, two agents that share the collections can load each other's sessions for the same user. To keep the sessions of each agent apart, give the store of each agent its own `scope`, for example the agent name. The store puts the scope in the user key. A store without a scope and a store with any scope also never share sessions. The turn lock has no scope: it is keyed by the user and the session id, so one turn also blocks a concurrent turn of the same user with the same session id on another agent.

  ```ts
  const assistant = ai.defineAgent({
    name: 'assistant',
    model: 'vertexai/gemini-2.5-flash',
    store: createUserScopedStore({ scope: 'assistant' }),
  });
  ```

- **One turn at a time.** A Firestore lease lock (`agent-kit-locks`) serializes the turns of each session. A second turn on a busy session gets 409 `ABORTED`. A turn that starts a new session (no `sessionId` or `snapshotId`) takes no lock.
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

## Security

> **Warning:** tools run as the function's service account, which has Admin SDK access. They bypass Firestore security rules.

- Build data paths from `context.auth.uid`. Never build them from model output alone.
- Keep tool input schemas narrow.
- Use an interrupt (`ai.defineInterrupt`) to get user approval before a tool writes or spends.
- Keep the four collections closed to client SDKs: `agent-kit-sessions`, `agent-kit-sessions-pointers`, `agent-kit-sessions-shards` (the message history) and `agent-kit-locks`. Only the function, through the Admin SDK, may touch them. Your Firestore rules must deny all client reads and writes there:

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

## Limits

- **No detached turns.** Cloud Functions throttles CPU after the response is sent, so a detached turn cannot finish reliably. A request with `detach: true` gets 400 `FAILED_PRECONDITION`.
- **Denied reads return 500.** When a user asks for a snapshot that is not theirs, `@genkit-ai/express` returns 500 for the `NOT_FOUND` error. This comes from upstream.
- **No session list.** Session documents sit under the user key, a sha256 hash, and there is no route that lists them. Clients must keep their own session ids.
- **Sessions are scoped by user unless you set a scope.** Without `scope`, a client can load a session of one agent into another agent that uses the same collections, for the same user only. Give the store of each agent its own `scope` (see Session scope under What it does) or its own `collection` to keep their sessions apart.
- **No cleanup.** Documents in all four collections stay in Firestore until you delete them. The library sets no TTL. A turn deletes its lock document when it ends, but a lock from a turn that did not end cleanly stays.

## Local development

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

The client is the stock `remoteAgent` from `genkit/beta/client`. Create it with a `headers` function as shown in [Usage](#usage). The same client works with a kit instance.

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

A turn that stops on an interrupt (`ai.defineInterrupt`) resolves with `finishReason: 'interrupted'`. Build a response with `respond` and send it with `chat.resume`:

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

## License

Apache-2.0
