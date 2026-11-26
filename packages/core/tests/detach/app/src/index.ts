import {
  createUserScopedStore,
  defineDetachedTurns,
  onAgentRequest,
  onAgentTask,
} from '@cabljac/firebase-agent-kit-core';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { genkit, type SessionStore } from 'genkit/beta';

initializeApp();

const ai = genkit({});

async function mark(tag: string | undefined, data: Record<string, unknown>) {
  if (!tag) return;
  await getFirestore()
    .collection('detach-test-events')
    .doc(tag)
    .set(
      { ...data, functionTarget: process.env.FUNCTION_TARGET ?? null },
      { merge: true },
    );
}

ai.defineModel(
  { name: 'test/scripted', apiVersion: 'v2' },
  async (request, { abortSignal }) => {
    const last = request.messages[request.messages.length - 1];
    const text = last?.content.map((part) => part.text ?? '').join('') ?? '';
    const reply = (t: string) => ({
      finishReason: 'stop' as const,
      message: { role: 'model' as const, content: [{ text: t }] },
    });
    const slow = /^slow (\d+)(?: (\S+))?$/.exec(text);
    if (slow) {
      const [, ms, tag] = slow;
      await mark(tag, { startedAt: Date.now() });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Number(ms));
        abortSignal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            void mark(tag, { abortedAt: Date.now() });
            reject(abortSignal.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
      return reply(`slept ${ms}`);
    }
    const crash = /^crash (\d+)(?: (\S+))?$/.exec(text);
    if (crash) {
      const [, ms, tag] = crash;
      await new Promise((r) => setTimeout(r, Number(ms)));
      await mark(tag, { crashedAt: Date.now() });
      process.exit(1);
    }
    if (text === 'count') {
      const users = request.messages.filter((m) => m.role === 'user').length;
      return reply(`user messages: ${users}`);
    }
    if (text.startsWith('echo ')) return reply(text.slice('echo '.length));
    return reply('unknown command');
  },
);

/**
 * Delays the first write of each snapshot by 25 seconds for a caller whose
 * claims hold `stallDetach`, so a detached run is claimed but its output is
 * late.
 */
function stallingStore<S>(inner: SessionStore<S>): SessionStore<S> {
  const seen = new Set<string>();
  return {
    getSnapshot: (o) => inner.getSnapshot(o),
    saveSnapshot: async (id, mutator, options) => {
      const token: unknown = options?.context?.auth?.token;
      const stall =
        typeof token === 'object' &&
        token !== null &&
        'stallDetach' in token &&
        id !== undefined &&
        !seen.has(id);
      if (id) seen.add(id);
      if (stall) await new Promise((r) => setTimeout(r, 25_000));
      return inner.saveSnapshot(id, mutator, options);
    },
    onSnapshotStateChange: (id, cb, options) =>
      inner.onSnapshotStateChange?.(id, cb, options),
  };
}

const store = stallingStore(createUserScopedStore());

const agent = ai.defineAgent({
  name: 'detachAgent',
  model: 'test/scripted',
  store,
  system: 'You are a deterministic test agent.',
});

const detach = defineDetachedTurns({
  queue: 'detachWorker',
  store,
  timeoutSeconds: 180,
});
export const detachAgent = onAgentRequest(agent, {
  httpsOptions: { timeoutSeconds: 120 },
  detach,
});
export const detachWorker = onAgentTask(agent, detach);

const short = defineDetachedTurns({
  queue: 'shortWorker',
  store,
  timeoutSeconds: 40,
});
export const shortAgent = onAgentRequest(agent, {
  httpsOptions: { timeoutSeconds: 120 },
  detach: short,
});
export const shortWorker = onAgentTask(agent, short);

const off = defineDetachedTurns({
  queue: 'detachWorker',
  store,
  enabled: false,
});
export const offAgent = onAgentRequest(agent, { detach: off });

export const stalledAgent = onAgentRequest(agent, {
  httpsOptions: { timeoutSeconds: 120 },
  detach: defineDetachedTurns({ queue: 'stalledWorker', store }),
});
/** Accepts tasks and never claims them. */
export const stalledWorker = onTaskDispatched(
  { retryConfig: { maxAttempts: 1 } },
  async () => {},
);

export const brokenAgent = onAgentRequest(agent, {
  httpsOptions: { timeoutSeconds: 120 },
  detach: defineDetachedTurns({ queue: 'missingWorker', store }),
});
