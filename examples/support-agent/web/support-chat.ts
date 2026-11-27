import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { type AgentChat, remoteAgent } from 'genkit/beta/client';

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
    ? 'http://127.0.0.1:5001/demo-agent-kit/europe-west1/kit-support-agent'
    : 'https://europe-west1-demo-agent-kit.cloudfunctions.net/kit-support-agent',
  headers: async () => {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in first.');
    return { Authorization: `Bearer ${await user.getIdToken()}` };
  },
});

/** The input of the `approveRefund` interrupt, as defined in `tools.ts`. */
interface RefundInput {
  orderId: string;
  amount: number;
  currency: string;
}

function isRefundInput(value: unknown): value is RefundInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.orderId === 'string' &&
    typeof v.amount === 'number' &&
    typeof v.currency === 'string'
  );
}

let current: { uid: string; chat: AgentChat } | undefined;

async function chatFor(uid: string): Promise<AgentChat> {
  if (current?.uid === uid) return current.chat;
  const sessionId = localStorage.getItem(`supportSessionId:${uid}`);
  let chat = agent.chat();
  if (sessionId) {
    chat = await agent.loadChat({ sessionId }).catch(() => agent.chat());
  }
  current = { uid, chat };
  return chat;
}

/**
 * Sends one message to the support agent, streams the reply into `render`,
 * and asks `confirm` before the agent files a refund request.
 */
export async function ask(
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
    localStorage.setItem(`supportSessionId:${uid}`, chat.sessionId);
  }

  while (response.finishReason === 'interrupted') {
    const approval = response.interrupts.find(
      (i) => i.name === 'approveRefund',
    );
    if (!approval) return;
    let approved = false;
    if (isRefundInput(approval.input)) {
      const { orderId, amount, currency } = approval.input;
      approved = await confirm(
        `Request a refund of ${amount} ${currency} for order ${orderId}?`,
      );
    } else {
      render('The refund request was malformed, so it was declined.\n');
    }
    response = await chat.resume({ respond: [approval.respond({ approved })] });
    render(response.text);
  }
}
