# @cabljac/firebase-agent-kit-core

> **Status:** experimental and pre-release. This is a community project, not an official Firebase or Genkit project, and it is not supported for production use. It is not published to npm yet. APIs, package names and behavior may change without notice. It requires Genkit 1.44 (beta agents API) and Node.js 22.12 or later.

Serve [Genkit](https://genkit.dev) agents from Firebase Cloud Functions, with per-user sessions and one turn at a time per session. This is the library under [`@cabljac/firebase-agent-kit`](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/agent-kit#readme). Use it directly when you want to write the `onRequest` function yourself instead of installing the kit.

`expressHandler(agent)` from `@genkit-ai/express` can already serve an agent from an `onRequest` function. This library adds what a multi-user production deployment needs on top of that route:

- **Firebase Auth on every route.** The turn route and the `/getSnapshot`, `/waitForSnapshot` and `/abort` routes all need a valid ID token. App Check is optional.
- **A uid-scoped session store.** One user cannot read, resume or abort the session of another user.
- **A per-session turn lock.** Two concurrent turns on one session get a clean 409 instead of racing on the same history.
- **Detached turns through Cloud Tasks (experimental).** A turn with `detach: true` runs in a separate task queue function, so it can outlive the HTTP request. Without the `detach` option, the library rejects such turns.

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

- **One turn at a time.** A Firestore lease lock (`agent-kit-locks`) serializes the turns of each session. A turn on a busy session retries the lock for about 1.5 seconds, then gets 409 `ABORTED`. A turn that starts a new session (no `sessionId` or `snapshotId`) takes no lock, except a detached one.
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

## Detached turns (experimental)

A detached turn runs in the background: the client gets a snapshot id at once and follows the turn with it. Cloud Functions throttles CPU after the response, so the turn cannot run in the HTTP function. The library hands it to a Cloud Tasks worker instead. Build both functions from one `defineDetachedTurns` object:

```ts
import {
  createUserScopedStore,
  defineDetachedTurns,
  onAgentRequest,
  onAgentTask,
} from '@cabljac/firebase-agent-kit-core';

const store = createUserScopedStore();
const assistant = ai.defineAgent({ name: 'assistant', model, store });

const detach = defineDetachedTurns({
  queue: 'assistantWorker', // the export name of the worker
  store, // the agent's own store
  timeoutSeconds: 900, // the worker timeout, at most 1800
});

export const assistantAgent = onAgentRequest(assistant, {
  httpsOptions: { timeoutSeconds: 120 },
  detach,
});
export const assistantWorker = onAgentTask(assistant, detach);
```

On the client, use `chat.detach` of the stock `remoteAgent`:

```ts
const task = await chat.detach('Write the quarterly report.');
const snapshot = await task.wait(); // or task.poll(), or task.abort()
```

`defineDetachedTurns` options:

| Option           | Default               | What it does                                                                                                                            |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `queue`          | required              | The export name of the `onAgentTask` function, which is also its queue.                                                                 |
| `store`          | required              | The agent's own session store. The turn route writes through it to settle a dead turn (see below).                                      |
| `enabled`        | `true`                | A boolean or a boolean params expression, read on each request and task. When off, `detach: true` gets 400 and the worker refuses work. |
| `timeoutSeconds` | `540`                 | The worker timeout, a number or an int params expression. Clamped to 60..1800.                                                          |
| `instanceId`     | none                  | Recorded on each run. A worker refuses the runs of another instance.                                                                    |
| `lock`           | a `FirestoreTurnLock` | The turn lock for every turn of the agent. Do not also set the `lock` option of `onAgentRequest`.                                       |
| `runs`           | `agent-kit-runs`      | `{ collection, firestore }` for the run documents.                                                                                      |

`onAgentTask(agent, detach, taskOptions?)` takes the other task queue options (memory, region, `rateLimits`, ...) as the third argument. It always sets `retryConfig.maxAttempts` to 1, and `rateLimits.maxConcurrentDispatches` defaults to 10.

**How it works.** The turn route runs authentication, App Check, `authorize`, the input check and `beforeTurn` as for any turn. Then it:

1. takes the session lock for the run, retrying briefly when it is busy (a new session gets a session id first, so every detached turn is locked);
2. settles a dead detached turn on the session (see crash recovery below);
3. writes a run document `agent-kit-runs/{runId}` with the uid, the decoded ID token claims, the input and the init;
4. enqueues a Cloud Task named after the run, with a dispatch deadline equal to the worker timeout;
5. waits up to 20 seconds for the worker to claim the run, then up to 20 seconds for the turn to start;
6. answers with Genkit's own `{ sessionId, snapshotId, finishReason: 'detached' }`, as one SSE frame for a streaming request or as a `{ result }` body otherwise, like `@genkit-ai/express`.

The worker claims the run in a transaction (a second delivery of the task is refused) and deletes the input, init and claims from the run document. It checks the user with `getAuth().getUser(uid)`, refreshes the custom claims, runs the turn with `detach: true`, records the output and waits until the snapshot settles. It renews the session lock every 30 seconds (90-second lease) and releases it at the end.

**When the turn does not start.**

| Case                                                                     | Result                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The task cannot be enqueued                                              | The run is cancelled, the lock released, 503 `UNAVAILABLE`.                                                                                                                                                       |
| No worker claims the run in 20 seconds                                   | The run is cancelled, the lock released, 503 `UNAVAILABLE`.                                                                                                                                                       |
| The client goes away while the run is queued                             | The run is cancelled and the lock released.                                                                                                                                                                       |
| The client goes away after the worker claimed the run                    | The turn keeps running. The client can find it again by its session id.                                                                                                                                           |
| The worker claimed the run but the turn did not start in 20 seconds      | 503 `UNAVAILABLE` (retry in a few seconds). The run is marked abandoned, and the worker aborts the turn as soon as its snapshot exists, so the client that got the 503 is not left with a turn running behind it. |
| The task reaches a worker more than 30 seconds after the run was written | The turn route is gone, so the worker cancels the run without running it and releases the lock.                                                                                                                   |
| The user is deleted or disabled, or revoked their tokens, by claim time  | The run is cancelled without running, the lock released, and the turn route answers 401 or 403.                                                                                                                   |
| The run document would pass Firestore's 1 MiB limit                      | 400 `INVALID_ARGUMENT`, before the lock.                                                                                                                                                                          |

**Crash recovery.** When the worker dies mid-turn, the snapshot stops getting heartbeats and reads as `expired`, and the lock lease lapses within 90 seconds. The next turn on the session takes the lock and, when the session's latest snapshot is `pending` or `aborting` with a heartbeat older than 60 seconds, rewrites it as `aborted` with the state of its parent snapshot. The turn then continues, whether the client names the session or the dead snapshot.

A crashed worker leaves its run document as `running` or `detached`, without a final status. The TTL policy removes it.

**Fencing.** When a renewal finds that the worker no longer holds the lock, the worker aborts its turn. It also aborts the turn when no renewal succeeded for 50 seconds, before the 90-second lease can lapse. The worker aborts the turn 20 seconds before its timeout and stops renewing then, so a hung turn cannot keep the lock alive past the timeout. When waiting for the turn fails, the worker aborts it before it releases the lock. A turn the worker stopped ends with the run status `aborted`; one the turn route gave up on ends `cancelled`.

### Required IAM and setup

- Enable the Cloud Tasks API (`cloudtasks.googleapis.com`).
- The runtime service account of the turn route needs `roles/cloudtasks.enqueuer` to enqueue, and `roles/run.invoker` (or the Cloud Functions invoker role) so the task can call the worker. Inside a Function Kit or an extension, firebase-admin sends each task with an ID token in the `Authorization` header, and no more IAM is needed. Elsewhere it sends an OIDC token, which also needs `iam.serviceAccounts.actAs` on the runtime service account. That case is not verified on a real deploy yet.
- The worker needs `roles/datastore.user` (run documents, locks, sessions) and `firebaseauth.users.get` (for example `roles/firebaseauth.viewer`) for the `getUser` check.
- Set a TTL policy on the `expireAt` field of the run collection. A run document is kept 7 days:

  ```sh
  gcloud firestore fields ttls update expireAt \
    --collection-group=agent-kit-runs --enable-ttl
  ```

- Set the HTTP function timeout to at least 60 seconds: the turn route waits up to 40 seconds for the worker.

### Detached turn limits

- **30-minute cap.** A detached turn runs at most `timeoutSeconds`, up to 1800 seconds.
- **Frozen claims.** The worker runs the turn with the ID token claims from the request, with the custom claims refreshed at claim time. It checks the user once, when it claims the run, not again during the turn.
- **No raw token.** The raw ID token is never stored or passed to the worker. In the worker, `context.auth` has `uid` and `token` only (`AgentAuthContext`), so a tool that needs the raw token cannot run detached.
- **Hooks at enqueue only.** App Check, `authorize` and `beforeTurn` run on the turn route, not in the worker.
- **No per-user limit.** `maxConcurrentDispatches` caps the running detached turns of the whole function, not of one user. One user can fill the queue. Use `beforeTurn` to rate-limit detached turns per user (it gets the parsed `input`, so it can check `input.detach`).
- **Broad roles.** `roles/run.invoker` and `roles/cloudtasks.enqueuer` are granted at the project level when you grant them to the service account there. Tools run as the same service account, so a tool could enqueue tasks or invoke other Cloud Run services in the project. Grant them on the queue and the worker service instead where you can.
- **Stale token times.** In the worker, `context.auth.token.iat` and `exp` are those of the original ID token and can be in the past. Do not use them to judge freshness.
- **Opaque config.** `defineDetachedTurns` returns an opaque `DetachedTurns` handle. Pass it on; do not read it.
- **The Functions emulator** does not pass a client disconnect on to the function, so the cancel on disconnect cannot be seen there.

## Security

> **Warning:** tools run as the function's service account, which has Admin SDK access. They bypass Firestore security rules.

- Build data paths from `context.auth.uid`. Never build them from model output alone.
- Keep tool input schemas narrow.
- Use an interrupt (`ai.defineInterrupt`) to get user approval before a tool writes or spends.
- Keep the five collections closed to client SDKs: `agent-kit-sessions`, `agent-kit-sessions-pointers`, `agent-kit-sessions-shards` (the message history), `agent-kit-locks` and `agent-kit-runs` (detached runs, which hold the input and the claims until a worker claims them). Only the functions, through the Admin SDK, may touch them. Your Firestore rules must deny all client reads and writes there:

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

## Limits

- **Detached turns need the `detach` option.** Without it, a request with `detach: true` gets 400 `FAILED_PRECONDITION`. See [Detached turns](#detached-turns-experimental) for their own limits.
- **Denied reads look like missing snapshots.** When a user asks `/getSnapshot` or `/waitForSnapshot` for a snapshot that is not theirs, the answer is 404 `NOT_FOUND`, the same as for an id that does not exist.
- **No session list.** Session documents sit under the user key, a sha256 hash, and there is no route that lists them. Clients must keep their own session ids.
- **Abort of another user's turn does nothing.** `/abort` with the snapshot id of another user answers 200 with no `status`, and the turn continues. The client's `abort()` resolves `undefined`.
- **Sessions are scoped by user unless you set a scope.** Without `scope`, a client can load a session of one agent into another agent that uses the same collections, for the same user only. Give the store of each agent its own `scope` (see Session scope under What it does) or its own `collection` to keep their sessions apart.
- **No cleanup.** Documents in the session and lock collections stay in Firestore until you delete them. The library sets no TTL on them; run documents carry an `expireAt` field for a TTL policy. A turn deletes its lock document when it ends, but a lock from a turn that did not end cleanly stays.

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
