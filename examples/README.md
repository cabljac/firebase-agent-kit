# Examples

A complete Firebase project that shows the kit after install: two instances, tools, skills, an approval interrupt and model fallback. It loads in the emulators with no Google Cloud project. A turn needs a real project for the model calls.

## `support-agent`

[`support-agent/`](support-agent) is the Firebase project of a fictional outdoor gear store, Acme Outfitters, after two runs of `firebase functions:kits:install` and a short customisation. It has two kit instances:

- **`support`**: a customer support agent. It reads the caller's own orders from Firestore, follows two skills, and asks the customer to approve a refund request before it files one.
- **`sales`**: a minimal pre-sales assistant. It has no tools and no skills, and it falls back to a second model.

The project id is `demo-agent-kit`. A `demo-` project runs only in the emulators, so you can start it without a Google Cloud project.

### What is in the project

`[install]` marks a file that `kits:install` writes. `[install, edited]` marks a generated file that the user changed. `[user]` marks a file that the user wrote.

```
support-agent/
  .firebaserc                              [user]    from firebase init
  firebase.json                            [install] "functions" block; emulators from firebase init; firestore by hand
  firestore.rules                          [user]    closes the kit collections
  web/support-chat.ts                      [user]    remoteAgent client for a web app
  function-kits/firebase-agent-kit/
    config-support/.env.demo-agent-kit     [install, edited] params of the support instance
    config-sales/.env.demo-agent-kit       [install, edited] params of the sales instance
    source/
      .gitignore                           [install]
      package.json                         [install]
      tsconfig.json                        [install]
      src/index.ts                         [install, edited] one import line added
      src/tools.ts                         [user]    the tools of the agents
      prompts/support.prompt               [user]
      prompts/sales.prompt                 [user]
      skills/support/refunds/SKILL.md      [user]
      skills/support/shipping/SKILL.md     [user]
```

`npm install` also writes `package-lock.json` and `node_modules/` in `source/`. They are not in this example.

## The user journey

### 1. Install the kit

Start in a Firebase project directory, with a `firebase.json` from `firebase init`. You need firebase-tools 15.27.0 or later (checked against 15.36.0).

```sh
firebase functions:kits:install --package @cabljac/firebase-agent-kit
```

The CLI asks these questions (abridged). The answers are the ones this example uses. The wording comes from the firebase-tools 15.36.0 source.

```
⚠  functions: Package @cabljac/firebase-agent-kit is a third-party kit (outside the @firebase-function-kits scope).
⚠  functions: Package @cabljac/firebase-agent-kit does not have an npm-shrinkwrap.json file. ...
? Are you sure you want to install the third-party kit @cabljac/firebase-agent-kit without locked dependencies? Yes
? What would you like to name this kit? firebase-agent-kit
i  functions: Running npm install @cabljac/firebase-agent-kit --save-prefix=^ --ignore-scripts...
i  functions: Saving resolved SDK dependencies: firebase-functions@=7.4.0, firebase-admin@=14.5.1...
i  functions: Building TypeScript source...
? What would you like to name this instance? support

FUNCTION_DEFAULT_REGION: Global default region where functions should be deployed. Can be overriden per-function.
? Enter a string value for FUNCTION_DEFAULT_REGION: europe-west1

Allowed browser origins: Web origins that may call this agent from a browser, ...
? Enter a list of strings (delimiter: ,) for Allowed browser origins: http://localhost:5173

Turn timeout in seconds: How long one agent turn can run before Cloud Functions stops it, ...
? Enter an integer value for Turn timeout in seconds: 120
? Select a value for Function memory: 512 MiB
? Select a value for Enforce App Check: Disabled
? Enter a string value for Vertex AI location: europe-west1
? Select a value for Detached turns (experimental): Disabled
? Enter an integer value for Detached turn timeout in seconds: 540
i  functions: Writing new parameter values to disk: function-kits/firebase-agent-kit/config-support/.env.demo-agent-kit
✔  functions: Function kit firebase-agent-kit successfully installed.
i  functions: At the first deploy, the following functions will be created in your project:
- kit-support-agent
- kit-support-agentWorker
i  functions: At the first deploy, the following Task Queues will be created in your project:
- kit-support-agentWorker
i  functions: At the first deploy, the following APIs will be enabled in your project:
- aiplatform.googleapis.com
- cloudtasks.googleapis.com
- firestore.googleapis.com
i  functions: At the first deploy, the following roles will be granted to the kit service account:
...
⚠  functions: Please review the changes above. If you do not want them applied to your project, uninstall this kit before running firebase deploy.
```

The install creates `function-kits/firebase-agent-kit/` and adds the `functions` block to [`firebase.json`](support-agent/firebase.json).

### 2. Add a second instance

Run the same command again. The CLI finds the installed kit, skips the npm install and asks only for the instance:

```
i  functions: This package is already installed as kit firebase-agent-kit, creating a new instance.
? What would you like to name this instance? sales
```

Then it asks for the params of `sales` and writes `config-sales/.env.demo-agent-kit`. Each instance deploys its own function, `kit-<instance>-agent`, with its own params and prompt.

### 3. Customise

The install gives you a working wrapper, but no agent yet. These are the edits:

| File                                                                                                     | What changed and why                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/index.ts`](support-agent/function-kits/firebase-agent-kit/source/src/index.ts)                     | One line, `import "./tools";`, below `setGlobalOptions`. The kit must load after the region is set, so the import cannot go at the top.                                                                                                                                                                                                                                                                                                        |
| [`src/tools.ts`](support-agent/function-kits/firebase-agent-kit/source/src/tools.ts)                     | `listOrders` and `lookupOrder` read `users/{uid}/orders`. `approveRefund` is an interrupt: the client asks the customer. `requestRefund` files a refund request. The prompt asks for approval first, but the server does not enforce it. The server does check that the filed amount matches the order total, and returns `amount_mismatch` when it does not. Every path comes from `context.auth.uid`, and the order id schema allows no `/`. |
| [`prompts/support.prompt`](support-agent/function-kits/firebase-agent-kit/source/prompts/support.prompt) | The model, the four tools, `use: [skills]` and `retry`. The file name is the instance id.                                                                                                                                                                                                                                                                                                                                                      |
| [`prompts/sales.prompt`](support-agent/function-kits/firebase-agent-kit/source/prompts/sales.prompt)     | No tools. `fallback` to `gemini-2.5-flash` when `gemini-2.5-pro` is unavailable. Every instance registers every tool, but only the `tools:` list decides what the model can call.                                                                                                                                                                                                                                                              |
| [`skills/support/*/SKILL.md`](support-agent/function-kits/firebase-agent-kit/source/skills/support)      | The refund policy and the shipping times. The model loads a skill only when it needs it.                                                                                                                                                                                                                                                                                                                                                       |
| [`config-*/.env.demo-agent-kit`](support-agent/function-kits/firebase-agent-kit/config-support)          | The install writes the comma form, `CORS_ORIGINS=http://localhost:5173`. The Functions emulator reads only the JSON form, so both files here use `CORS_ORIGINS=["http://localhost:5173"]`.                                                                                                                                                                                                                                                     |
| [`firestore.rules`](support-agent/firestore.rules)                                                       | Customers can read their own orders and refund requests. The five `agent-kit-*` collections are closed to client SDKs.                                                                                                                                                                                                                                                                                                                         |

### 4. Run it and deploy

In the emulators, from `support-agent/`:

```sh
npm --prefix function-kits/firebase-agent-kit/source run build
firebase emulators:start --only functions,firestore,auth
```

Both instances load, at `http://127.0.0.1:5001/demo-agent-kit/europe-west1/kit-support-agent` and `.../kit-sales-agent`. Requests pass auth and the kit's configuration check. A turn then fails at the model call, because a `demo-` project has no Vertex AI. For real model calls, use a real project with Application Default Credentials.

In a real project, the params file is `.env.<your project id>`. Deploy:

```sh
firebase deploy --only functions,firestore:rules
```

`--only functions:support` deploys one instance. The first deploy asks you to confirm the kit's service account.

### 5. Chat with it

From the terminal, in `support-agent/`:

```sh
fak support --email you@example.com
```

Until the package is on npm, [build `fak` from this repo](../packages/cli/README.md#run-it) and alias it.

This step assumes that `.firebaserc` and the `.env.<projectId>` files point at your real project, after a deploy. `fak` reads the project from `.firebaserc` and the region from the params file, signs you in and streams the replies. Ask "I want to return the tent from my last order." The agent lists your orders, loads the `refunds` skill and checks that the order is refundable. Then it calls `approveRefund`, and `fak` shows an approval card with the order id and the amount. Press `a` to approve or `d` to deny. On approval, the agent files the request and confirms it.

From a web app, [`web/support-chat.ts`](support-agent/web/support-chat.ts) uses the stock `remoteAgent` client. It calls the emulator on `localhost` and the deployed function elsewhere. It streams the reply, keeps the session id in `localStorage`, and calls a `confirm` callback of the page when the agent asks with `approveRefund`.

## Which files match `kits:install` exactly

The generated files are copied from the firebase-tools 15.36.0 templates and code, so they are excluded from Biome:

| File                                 | Source in `firebase-tools/lib` and `templates`                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source/src/index.ts`                | `templates/init/functions/typescript/index-kit.ts`, with the package name (`functions/kits/sources/npm.js`, `writeKitIndexTs`). One line added.                                                                                                                        |
| `source/tsconfig.json`, `.gitignore` | `templates/init/functions/typescript/tsconfig.json` and `_gitignore` (`scaffoldKitFiles`).                                                                                                                                                                             |
| `source/package.json`                | `templates/init/functions/typescript/package-kit.json`, named `<kit>-wrapper`, with `engines.node` set to the latest runtime, `24` (`writeKitPackageJson`). npm then adds the kit, `firebase-admin` and `firebase-functions` with a `^` prefix (`buildAndInstallKit`). |
| `firebase.json` `functions` block    | `addKitToConfig` and `addInstanceToKitConfig` in `functions/kits/install.js`, written with `JSON.stringify(config, null, 2)`.                                                                                                                                          |
| `config-<instance>/.env.<projectId>` | `promptAndWriteKitParams` in `functions/kits/install.js` and `writeUserEnvs` in `functions/env.js`: one `KEY=value` line per param, in the order the code defines them.                                                                                                |

CI lints the files that the user wrote. It does not typecheck or build them, because the example is not part of the pnpm workspace.

Inferred, not generated:

- The kit version is `^0.0.0`, the version in this repo. A published version would differ.
- The `emulators` block of `firebase.json` matches `firebase init`. The `firestore` block is written by hand: `firebase init` 15.36.0 also writes `database`, `location` and `indexes`, and a `firestore.indexes.json` file. The CLI appends the `functions` block after them.
- The packages are not on npm, so `kits:install` cannot run for real yet. The example was checked like this: the workspace packages were packed, the npm commands that `kits:install` runs were run against the tarballs, the wrapper was built with TypeScript 6.0.3, and both instances were started in the Functions, Firestore and Auth emulators.
