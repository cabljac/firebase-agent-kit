# Examples

A complete Firebase project that shows most features of the kit after install: two instances, per-user tools, server-side dice, a restartable approval, skills, retry and fallback, session resume and a detached turn. It loads in the emulators with no Google Cloud project. A turn needs a real project for the model calls.

## `game-master`

[`game-master/`](game-master) is the Firebase project of a text adventure game, after two runs of `firebase functions:kits:install` and a short customisation. Each kit instance is a game master for one world:

- **`fantasy`**: an adventure in the Shattered Vale. It uses `retry` for model calls, has three skills (`combat`, `magic`, `worldbuilding`) and has detached turns on, for a long "build a new world" turn.
- **`scifi`**: an adventure on Kestrel Station. It uses `fallback` from `gemini-2.5-pro` to `gemini-2.5-flash` and has two skills (`hacking`, `npcs`).

Both instances share the same tools. The player's character sheet lives in Firestore at `users/{uid}/characters/{instance id}`, so each player has one character per world.

The project id is `demo-agent-kit`. A `demo-` project runs only in the emulators, so you can start it without a Google Cloud project.

### What is in the project

`[install]` marks a file that `kits:install` writes. `[install, edited]` marks a generated file that the user changed. `[user]` marks a file that the user wrote.

```
game-master/
  .firebaserc                                     [user]    from firebase init
  firebase.json                                   [install] "functions" block; emulators from firebase init; firestore by hand
  firestore.rules                                 [user]    own character only; closes the kit collections
  web/game-chat.ts                                [user]    remoteAgent client for a web app
  function-kits/firebase-agent-kit/
    config-fantasy/.env.demo-agent-kit            [install, edited] params of the fantasy instance
    config-scifi/.env.demo-agent-kit              [install, edited] params of the scifi instance
    source/
      .gitignore                                  [install]
      package.json                                [install]
      tsconfig.json                               [install]
      src/index.ts                                [install, edited] two lines added
      src/tools.ts                                [user]    the tools of both game masters
      prompts/fantasy.prompt                      [user]
      prompts/scifi.prompt                        [user]
      skills/fantasy/combat/SKILL.md              [user]
      skills/fantasy/magic/SKILL.md               [user]
      skills/fantasy/worldbuilding/SKILL.md       [user]
      skills/scifi/hacking/SKILL.md               [user]
      skills/scifi/npcs/SKILL.md                  [user]
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
? What would you like to name this instance? fantasy

FUNCTION_DEFAULT_REGION: Global default region where functions should be deployed. Can be overriden per-function.
? Enter a string value for FUNCTION_DEFAULT_REGION: europe-west1

Allowed browser origins: Web origins that may call this agent from a browser, ...
? Enter a list of strings (delimiter: ,) for Allowed browser origins: http://localhost:5173

Turn timeout in seconds: How long one agent turn can run before Cloud Functions stops it, ...
? Enter an integer value for Turn timeout in seconds: 120
? Select a value for Function memory: 512 MiB
? Select a value for Enforce App Check: Disabled
? Enter a string value for Vertex AI location: europe-west1
? Select a value for Detached turns (experimental): Enabled
? Enter an integer value for Detached turn timeout in seconds: 600
i  functions: Writing new parameter values to disk: function-kits/firebase-agent-kit/config-fantasy/.env.demo-agent-kit
✔  functions: Function kit firebase-agent-kit successfully installed.
i  functions: At the first deploy, the following functions will be created in your project:
- kit-fantasy-agent
- kit-fantasy-agentWorker
i  functions: At the first deploy, the following Task Queues will be created in your project:
- kit-fantasy-agentWorker
i  functions: At the first deploy, the following APIs will be enabled in your project:
- aiplatform.googleapis.com
- cloudtasks.googleapis.com
- firestore.googleapis.com
i  functions: At the first deploy, the following roles will be granted to the kit service account:
...
⚠  functions: Please review the changes above. If you do not want them applied to your project, uninstall this kit before running firebase deploy.
```

The install creates `function-kits/firebase-agent-kit/` and adds the `functions` block to [`firebase.json`](game-master/firebase.json).

### 2. Add a second instance

Run the same command again. The CLI finds the installed kit, skips the npm install and asks only for the instance:

```
i  functions: This package is already installed as kit firebase-agent-kit, creating a new instance.
? What would you like to name this instance? scifi
```

Then it asks for the params of `scifi` and writes `config-scifi/.env.demo-agent-kit`. This example answers `Disabled` for detached turns and keeps the default worker timeout, `540`. Each instance deploys its own function, `kit-<instance>-agent`, with its own params and prompt.

### 3. Customise

The install gives you a working wrapper, but no agent yet. These are the edits:

| File                                                                                                   | What changed and why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/index.ts`](game-master/function-kits/firebase-agent-kit/source/src/index.ts)                     | Two lines below `setGlobalOptions`: a comment and `import "./tools";`. The kit must load after the region is set, so the import cannot go at the top.                                                                                                                                                                                                                                                                                                                                                      |
| [`src/tools.ts`](game-master/function-kits/firebase-agent-kit/source/src/tools.ts)                     | `getCharacter`, `createCharacter` and `updateCharacter` read and write `users/{uid}/characters/{instance id}` in transactions. `rollDice` rolls on the server with `crypto.randomInt`. `attemptRiskyAction` asks the player first, then rolls and applies the damage of a failure. Every path comes from `context.auth.uid`. Inputs are length-limited and every amount is bounded. An amount out of range returns an outcome such as `invalid_amount` with the allowed range, so the model can try again. |
| [`prompts/fantasy.prompt`](game-master/function-kits/firebase-agent-kit/source/prompts/fantasy.prompt) | The model, the five tools, `use: [skills]` and `retry` with `maxRetries: 2`. The file name is the instance id.                                                                                                                                                                                                                                                                                                                                                                                             |
| [`prompts/scifi.prompt`](game-master/function-kits/firebase-agent-kit/source/prompts/scifi.prompt)     | The same tools and skills. `fallback` to `gemini-2.5-flash` when `gemini-2.5-pro` is unavailable.                                                                                                                                                                                                                                                                                                                                                                                                          |
| [`skills/<instance>/*/SKILL.md`](game-master/function-kits/firebase-agent-kit/source/skills)           | Short rules for combat, magic, worldbuilding, hacking and the people of the station. The model loads a skill only when it needs it. Each instance reads only its own `skills/<instance id>/` directory.                                                                                                                                                                                                                                                                                                    |
| [`config-*/.env.demo-agent-kit`](game-master/function-kits/firebase-agent-kit/config-fantasy)          | The install writes the comma form, `CORS_ORIGINS=http://localhost:5173`. The Functions emulator reads only the JSON form, so both files here use `CORS_ORIGINS=["http://localhost:5173"]`.                                                                                                                                                                                                                                                                                                                 |
| [`firestore.rules`](game-master/firestore.rules)                                                       | A player can read only their own characters. The five `agent-kit-*` collections are closed to client SDKs.                                                                                                                                                                                                                                                                                                                                                                                                 |

`hpChange` and `coinsChange` come from the model. The tool checks only the bounds, the inventory and the coin balance. For anything of real value, put the rules in the tool on the server, not in the prompt.

Every instance runs the whole wrapper, so both instances register every tool. The tools find the world from `FIREBASE_KIT_INSTANCE_ID`, which firebase-tools sets for each kit instance, in a deploy and in the emulator.

**The code enforces the approval.** `attemptRiskyAction` is a [restartable approval](../packages/agent-kit/README.md#restartable-approvals). On its first run, it calls `interrupt({ kind: 'approval', summary, onFailure })` and stops. The client restarts the tool with the same input and `{ approved: true }` or `{ approved: false }` in the tool's `resumed` option. Only an approved restart rolls the die and applies the damage. A denied restart returns `declined`, and a restart without `resumed` asks again. The model cannot get this tool's roll or damage without the question, because they live in the same tool. The client sends the tool's `resumed` option, so the server does not verify who approved, but the tool still reads only the caller's own character.

### 4. Run it and deploy

In the emulators, from `game-master/`:

```sh
npm --prefix function-kits/firebase-agent-kit/source install
npm --prefix function-kits/firebase-agent-kit/source run build
firebase emulators:start --only functions,firestore,auth
```

Until the package is on npm, the `install` step cannot fetch it. Install the packed workspace tarballs instead, as described in [Which files match `kits:install` exactly](#which-files-match-kitsinstall-exactly).

Both instances load, at `http://127.0.0.1:5001/demo-agent-kit/europe-west1/kit-fantasy-agent` and `.../kit-scifi-agent`, each with its `agentWorker`. Requests pass auth and the kit's configuration checks, including the detached turn checks on `fantasy`. A turn then fails at the model call, because a `demo-` project has no Vertex AI. For real model calls, use a real project with Application Default Credentials.

In a real project, the params file is `.env.<your project id>`. `fantasy` has `DETACHED_TURNS=true`, so set the TTL policy for the run documents before the first detached turn:

```sh
gcloud firestore fields ttls update expireAt \
  --collection-group=agent-kit-runs --enable-ttl
```

Then deploy:

```sh
firebase deploy --only functions,firestore:rules
```

`--only functions:fantasy` deploys one instance. The first deploy asks you to confirm the kit's service account.

### 5. Play with `fak`

This step assumes that `.firebaserc` and the `.env.<projectId>` files point at your real project, after a deploy. Until the package is on npm, [build `fak` from this repo](../packages/cli/README.md#run-it) and alias it. From `game-master/`:

```sh
fak fantasy --email you@example.com
```

`fak` reads the project from `.firebaserc` and the region from the params file, signs you in and streams the replies.

1. **Create a character.** Say "Hi". The game master calls `getCharacter`, finds nothing and asks for a name and a class. Answer "Mira, a ranger with a rope and a bow". It calls `createCharacter`. The server rolls her hit points and coins.
2. **Roll.** Say "I sneak past the goblin camp." The game master calls `rollDice`, and the reply names the roll. The model never makes up a number.
3. **Confirm a risky action.** Say "I pick the lock of the old tower." The game master calls `attemptRiskyAction`, and `fak` shows an approval card with the action, the roll it needs and what happens on a failure. Press `a` to try it or `d` to step back. `fak` restarts the tool with your answer. On `a`, the server rolls 1d20 and, on a failure, takes 1d4 hit points from your character. On `d`, nothing is rolled. The prompts allow one `attemptRiskyAction` per reply: Gemini sends no tool request ids, so the server cannot tell two parallel interrupts of the same tool apart. After other damage or loot, the game master calls `updateCharacter`.
4. **Leave and come back.** Type `/quit`. Later, run `fak fantasy --resume`. `fak` loads the last session of this instance and shows the story so far, and the character sheet is still in Firestore. `/session` shows the session id, and `/resume <id>` switches to another one.
5. **Build a world in the background.** Type `/detach Build a new world for my campaign.` The turn runs in `kit-fantasy-agentWorker` through Cloud Tasks, so it can take longer than an HTTP request. `fak` shows the snapshot id and waits. Press Ctrl+C to stop waiting; the turn keeps running. Run `fak fantasy --resume` again: `fak` shows the history and waits for the result of the running turn. The `worldbuilding` skill sets the shape of the answer: regions, factions, a starting village and a first rumour.

Then try the other world with `fak scifi --email you@example.com`. It is a new character and a new session: each instance keeps its own sessions, and the tools store one character per instance id. `/detach` there gets 400 `FAILED_PRECONDITION`, because `scifi` has `DETACHED_TURNS=false`.

### 6. Web client

[`web/game-chat.ts`](game-master/web/game-chat.ts) uses the stock `remoteAgent` client from `genkit/beta/client` and the Firebase JS SDK, and nothing from the server SDK. It calls the emulator on `localhost` and `127.0.0.1` and the deployed `fantasy` function elsewhere. It waits for `auth.authStateReady()` before it opens a chat, keeps the session id in `localStorage` per user, and starts a new chat when the saved one does not load. It streams the reply. When `attemptRiskyAction` asks for approval, it calls a `confirm` callback of the page and restarts the tool with `{ ...interrupt.restart(), metadata: { resumed: { approved } } }`. It reads `kind: 'approval'` from `response.toolRequests[i].metadata.interrupt`, because `response.interrupts` drops the metadata. It declines a malformed or unknown interrupt and tells the player. To start a detached turn from a web app, see [Detached turns](../packages/core/README.md#detached-turns-experimental) (`chat.detach`).

## Which files match `kits:install` exactly

The generated files are copied from the firebase-tools 15.36.0 templates and code, so they are excluded from Biome:

| File                                 | Source in `firebase-tools/lib` and `templates`                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source/src/index.ts`                | `templates/init/functions/typescript/index-kit.ts`, with the package name (`functions/kits/sources/npm.js`, `writeKitIndexTs`). Two lines added: a comment and an import.                                                                                              |
| `source/tsconfig.json`, `.gitignore` | `templates/init/functions/typescript/tsconfig.json` and `_gitignore` (`scaffoldKitFiles`).                                                                                                                                                                             |
| `source/package.json`                | `templates/init/functions/typescript/package-kit.json`, named `<kit>-wrapper`, with `engines.node` set to the latest runtime, `24` (`writeKitPackageJson`). npm then adds the kit, `firebase-admin` and `firebase-functions` with a `^` prefix (`buildAndInstallKit`). |
| `firebase.json` `functions` block    | `addKitToConfig` and `addInstanceToKitConfig` in `functions/kits/install.js`, written with `JSON.stringify(config, null, 2)`.                                                                                                                                          |
| `config-<instance>/.env.<projectId>` | `promptAndWriteKitParams` in `functions/kits/install.js` and `writeUserEnvs` in `functions/env.js`: one `KEY=value` line per param, in the order the code defines them.                                                                                                |

CI lints the files that the user wrote. It does not typecheck or build them, because the example is not part of the pnpm workspace.

Inferred, not generated:

- The kit version is `^0.0.0`, the version in this repo. A published version would differ.
- The `emulators` block of `firebase.json` matches `firebase init`. The `firestore` block is written by hand: `firebase init` 15.36.0 also writes `database`, `location` and `indexes`, and a `firestore.indexes.json` file. The CLI appends the `functions` block after them.
- The packages are not on npm, so `kits:install` cannot run for real yet. The example was checked like this: the workspace packages were packed, the npm commands that `kits:install` runs were run against the tarballs, the wrapper was built with TypeScript 6.0.3, and both instances were started in the Functions, Firestore, Auth and Cloud Tasks emulators. The tools were run against the Firestore emulator, and the web client was typechecked against firebase 12.19.0 and genkit 1.44.0 and bundled for the browser.
