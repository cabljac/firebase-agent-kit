# @cabljac/firebase-agent-kit-cli

> **Status:** experimental and pre-release. This is a community project, not an official Firebase or Genkit project. It is not published to npm yet. The name and the options may change.

`fak` is a terminal chat client for agents served by the [agent kit](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/agent-kit#readme) or by [`onAgentRequest`](https://github.com/cabljac/firebase-agent-kit/tree/main/packages/core#readme). It streams replies, shows tool approvals as cards, resumes sessions and explains errors. It uses the stock `remoteAgent` client, so it also shows how a client handles streaming, interrupts, sessions and errors. The published package is one bundled file with no dependencies.

## Run it

Once the package is on npm:

```sh
npx @cabljac/firebase-agent-kit-cli --help
```

Until then, build it in this repo and alias the `bin`:

```sh
pnpm install && pnpm build
alias fak="node $PWD/packages/cli/lib/bin.js"
```

In a Firebase project directory with a kit instance, no URL is needed:

```sh
fak --email you@example.com          # the only instance, or a picker
fak support --email you@example.com  # a named instance
fak                                  # reconnect to the last agent
```

The client finds `firebase.json` in the current directory or above it. It reads the project from `.firebaserc` (the `default` alias, or `--project`), the instances from the `instances` map of the kit config, and the region from `FUNCTION_DEFAULT_REGION` in the instance's `.env`, `.env.<projectId>` and `.env.<alias>` files (later files win; the default is `us-central1`). It then calls `https://<region>-<project>.cloudfunctions.net/kit-<instance>-agent`.

Outside a project directory, name the instance and the project, or pass the URL:

```sh
fak support --project my-project --region europe-west1 --email you@example.com
fak --url https://<region>-<project>.cloudfunctions.net/<function> \
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

## API key

With a project, the client looks up the web API key through the Firebase Management API. It uses your Application Default Credentials (`gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`). When all web apps of the project use the same key, it uses that key; otherwise it asks which app. Without credentials, it asks for the key once. It caches the key per project in `state.json`. The key is public configuration, not a secret.

## Sign-in

The first run asks for the password. The client signs in with the Identity Toolkit REST API and keeps the refresh token in `credentials.json` in its config directory (`$XDG_CONFIG_HOME/firebase-agent-kit`, or `~/Library/Application Support/firebase-agent-kit` on macOS, `~/.config/firebase-agent-kit` on Linux). The files have mode 0600. The password is not saved. Later runs refresh the ID token before it expires and do not ask again. `--logout` deletes the saved refresh token. Set `FIREBASE_AUTH_EMULATOR_HOST` to sign in against the Auth emulator; emulator sign-ins are kept apart from production ones, and the header shows the emulator.

## In the chat

| Input               | What it does                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `/new`              | Start a new session.                                                                                                        |
| `/detach <message>` | Send a detached turn and wait for its result.                                                                               |
| `/resume <id>`      | Switch to an existing session.                                                                                              |
| `/session`          | Show the current session id.                                                                                                |
| `/help`             | Show the commands.                                                                                                          |
| `/quit`             | Exit. `/exit` and Ctrl+C at the prompt also exit.                                                                           |
| `//text`            | Send a message that starts with `/`.                                                                                        |
| Ctrl+C              | During a reply: stop the stream on this side only. While waiting for a detached turn: stop waiting; the turn keeps running. |

- **Interrupts.** A turn that stops on an interrupt shows an approval card with the tool name and its input. `a` sends `{"approved": true}`, `d` sends `{"approved": false}`, and `e` lets you type any JSON response. The client cannot see the output schema of the interrupt, so pick `e` when the tool expects something else. Esc leaves the card; `/resume <id>` shows it again.
- **409.** When another turn holds the session, the client says so. Press `r` to reload the session and send again (also for `/detach`), or Esc to get the message back in the prompt.
- **Detached turns.** `/detach <message>` needs an agent with detached turns on (the kit's `DETACHED_TURNS` param). The client shows the snapshot id of the running turn, waits for it, then shows the reply and how the turn ended. `/resume <id>` (or `--resume`) on a session with a running detached turn shows the history before it and waits for its result. When the worker of the turn stopped, the client says so; the next message continues from the turn before it.
- **Colours.** Set `NO_COLOR` to turn colours off; bold, dim and the cursor stay. When stdin or stdout is not a terminal, the client reads one message per line, prints plain text, and writes problems to stderr. An interrupt then reads `approve`, `deny` or a JSON value from the next line. The exit code is 1 when a turn failed.

## Editing keys

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

Requires Node.js 22.12 or later.

## License

Apache-2.0
