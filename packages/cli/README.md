# genkit-agent-chat

> **Status:** experimental and pre-release. The name and the options may change.

A terminal chat client for Genkit agents served by [`genkit-agent-functions`](../../README.md) (`onAgentRequest`) or by the agent kit. It streams replies, shows tool approvals as cards, resumes sessions and explains errors.

```sh
# In a Firebase project directory with a kit instance:
genkit-agent-chat --email you@example.com

# Anywhere:
genkit-agent-chat support --project my-project --email you@example.com
genkit-agent-chat --url https://<region>-<project>.cloudfunctions.net/<function> --api-key <key> --email you@example.com
```

Run `genkit-agent-chat --help` for all options, and type `/help` in the chat for commands. See [Terminal client](../../README.md#terminal-client) in the repo README for sign-in, keys and editing.

Requires Node.js 22.12 or later. Apache-2.0.
