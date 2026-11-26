import type {
  ChatSession,
  LoadedSession,
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

/** A turn that stopped on one `approveTransfer` interrupt. */
export const interrupted: TurnOutcome = {
  status: 'interrupted',
  text: '',
  tools: [],
  interrupts: [{ name: 'approveTransfer', ref: 'r1', input: { amount: 5 } }],
};
