import type {
  ChatSession,
  DetachedOutcome,
  DetachHandlers,
  LoadedSession,
  PendingInterrupt,
  TurnHandlers,
  TurnInput,
  TurnOutcome,
} from '../../src/chat.js';

/** A turn script: what the fake session does for each input. */
export type Script = (
  input: TurnInput,
  handlers: TurnHandlers,
) => Promise<TurnOutcome>;

/** A scripted chat session that records what the screen sends. */
export class FakeSession implements ChatSession {
  sessionId: string | undefined;
  turns: TurnInput[] = [];
  signals: (AbortSignal | undefined)[] = [];
  reloads = 0;
  constructor(
    private script: Script,
    private load: (id: string) => Promise<LoadedSession> = async () => ({
      history: [],
      pending: [],
    }),
  ) {}
  newSession() {
    this.sessionId = undefined;
  }
  async loadSession(id: string, signal?: AbortSignal) {
    const loaded = await this.load(id);
    signal?.throwIfAborted();
    this.sessionId = id;
    return loaded;
  }
  async reload() {
    this.reloads++;
  }
  detaches: string[] = [];
  waits: string[] = [];
  /** What `detach` and `waitDetached` do; settles at once by default. */
  detachScript: (
    snapshotId: string,
    signal?: AbortSignal,
  ) => Promise<DetachedOutcome> = async (snapshotId) => ({
    snapshotId,
    status: 'completed',
    text: 'background done',
  });
  /** Rejects `detach` with this error before it starts, when set. */
  detachError: unknown;
  async detach(message: string, handlers: DetachHandlers = {}) {
    this.detaches.push(message);
    if (this.detachError) {
      const err = this.detachError;
      this.detachError = undefined;
      throw err;
    }
    this.sessionId = 's1';
    handlers.onDetached?.('snap1');
    return this.detachScript('snap1', handlers.signal);
  }
  waitDetached(snapshotId: string, signal?: AbortSignal) {
    this.waits.push(snapshotId);
    return this.detachScript(snapshotId, signal);
  }
  runTurn(input: TurnInput, handlers: TurnHandlers = {}) {
    this.turns.push(input);
    this.signals.push(handlers.signal);
    this.sessionId = 's1';
    return this.script(input, handlers);
  }
}

/** A finished turn with `text`. */
export const done = (text: string): TurnOutcome => ({
  status: 'done',
  text,
  tools: [],
});

/** One pending `approveTransfer` interrupt. */
export const transfer: PendingInterrupt = {
  name: 'approveTransfer',
  ref: 'r1',
  input: { amount: 5 },
};

/** A turn that stopped on one `approveTransfer` interrupt. */
export const interrupted: TurnOutcome = {
  status: 'interrupted',
  text: '',
  tools: [],
  interrupts: [transfer],
};
