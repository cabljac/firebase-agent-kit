import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  type AgentChat,
  remoteAgent,
  type ToolRequestPart,
  type ToolResponsePart,
} from 'genkit/beta/client';

// Replace with the web app config of your project from the Firebase console.
const app = initializeApp({
  apiKey: 'fake-api-key',
  projectId: 'demo-agent-kit',
});
const auth = getAuth(app);

const emulated = ['localhost', '127.0.0.1'].includes(location.hostname);
if (emulated) connectAuthEmulator(auth, 'http://127.0.0.1:9099');

const agent = remoteAgent({
  url: emulated
    ? 'http://127.0.0.1:5001/demo-agent-kit/europe-west1/kit-fantasy-agent'
    : 'https://europe-west1-demo-agent-kit.cloudfunctions.net/kit-fantasy-agent',
  headers: async () => {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in first.');
    return { Authorization: `Bearer ${await user.getIdToken()}` };
  },
});

/** What `attemptRiskyAction` passes to `interrupt()`, as defined in `tools.ts`. */
interface Approval {
  kind: 'approval';
  summary: string;
  onFailure: string;
}

function isApproval(value: unknown): value is Approval {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === 'approval' &&
    typeof v.summary === 'string' &&
    typeof v.onFailure === 'string'
  );
}

let current: { uid: string; chat: AgentChat } | undefined;

async function chatFor(uid: string): Promise<AgentChat> {
  if (current?.uid === uid) return current.chat;
  const sessionId = localStorage.getItem(`fantasySessionId:${uid}`);
  let chat = agent.chat();
  if (sessionId) {
    chat = await agent.loadChat({ sessionId }).catch(() => agent.chat());
  }
  current = { uid, chat };
  return chat;
}

/**
 * Sends one player move to the fantasy game master, streams the reply into
 * `render`, and asks `confirm` before a risky action.
 */
export async function play(
  text: string,
  render: (chunk: string) => void,
  confirm: (question: string) => Promise<boolean>,
): Promise<void> {
  await auth.authStateReady();
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in first.');
  const chat = await chatFor(uid);

  const turn = chat.sendStream(text);
  for await (const chunk of turn.stream) render(chunk.text);
  let response = await turn.response;
  if (chat.sessionId) {
    localStorage.setItem(`fantasySessionId:${uid}`, chat.sessionId);
  }

  while (response.finishReason === 'interrupted') {
    const restart: ToolRequestPart[] = [];
    const respond: ToolResponsePart[] = [];
    // `interrupts` drops the metadata; it is built from these parts, in this order.
    const parts = response.toolRequests.filter((p) => p.metadata?.interrupt);
    for (const [i, interrupt] of response.interrupts.entries()) {
      const metadata = parts[i]?.metadata?.interrupt;
      if (interrupt.name === 'attemptRiskyAction') {
        let approved = false;
        if (isApproval(metadata)) {
          approved = await confirm(
            `${metadata.summary}\nIf it fails: ${metadata.onFailure}`,
          );
        } else {
          render(
            'The game master sent a malformed question, so it was declined.\n',
          );
        }
        // A bare restart() carries no `resumed`, so the tool would ask again.
        restart.push({
          ...interrupt.restart(),
          metadata: { resumed: { approved } },
        });
      } else {
        render(
          `The game master asked "${interrupt.name}", which this page cannot answer, so it was declined.\n`,
        );
        respond.push(interrupt.respond({ approved: false }));
      }
    }
    response = await chat.resume({
      ...(restart.length > 0 && { restart }),
      ...(respond.length > 0 && { respond }),
    });
    render(response.text);
  }
}
