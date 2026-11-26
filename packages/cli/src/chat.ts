import {
  type AgentAPI,
  type AgentChat,
  type MessageData,
  remoteAgent,
  type ToolResponsePart,
} from 'genkit/beta/client';
import type { TokenSource } from './auth.js';
import type { ConfigStore } from './store.js';

/** A tool call the agent paused on, waiting for the user's response. */
export interface PendingInterrupt {
  name: string;
  ref?: string;
  input: unknown;
}

/** What the user sends: a new message, or responses to interrupts. */
export type TurnInput =
  | { message: string }
  | { respond: { interrupt: PendingInterrupt; output: unknown }[] };

/** How a turn ended. */
export type TurnOutcome =
  | { status: 'done'; text: string; tools: string[] }
  | {
      status: 'interrupted';
      text: string;
      tools: string[];
      interrupts: PendingInterrupt[];
    }
  | { status: 'aborted'; text: string; tools: string[] };

/** Callbacks for a streaming turn. */
export interface TurnHandlers {
  /** Called with all the reply text so far, each time it grows. */
  onText?: (text: string) => void;
  /**
   * Called when the model requests a tool. The model's chunks do not mark
   * interrupts, so an interrupt is reported here too.
   */
  onToolCall?: (name: string) => void;
  signal?: AbortSignal;
}

/** One entry of the conversation, as shown to the user. */
export type HistoryEntry =
  | { role: 'user'; text: string }
  | { role: 'agent'; text: string; tools: string[] };

interface ToolRequestLike {
  toolRequest?: { name: string; ref?: string; input?: unknown };
  metadata?: Record<string, unknown>;
}

const isInterrupt = (part: ToolRequestLike) => !!part.metadata?.interrupt;

/**
 * Builds the resume part that answers `interrupt` with `output`.
 * @param interrupt The pending interrupt.
 * @param output The tool output to send back.
 */
export function respondPart(
  interrupt: PendingInterrupt,
  output: unknown,
): ToolResponsePart {
  return {
    toolResponse: {
      name: interrupt.name,
      ...(interrupt.ref !== undefined && { ref: interrupt.ref }),
      output,
    },
  };
}

/**
 * Converts stored messages into entries for display. The model messages of
 * one turn become one entry. Tool responses and system messages are left out.
 * @param messages Messages from a session snapshot.
 */
export function historyEntries(messages: MessageData[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const m of messages) {
    const text = m.content.map((p) => p.text ?? '').join('');
    if (m.role === 'user' && text) entries.push({ role: 'user', text });
    if (m.role === 'model') {
      const tools = m.content
        .filter((p) => p.toolRequest && !isInterrupt(p))
        .map((p) => p.toolRequest?.name ?? '');
      if (!text && !tools.length) continue;
      const last = entries[entries.length - 1];
      if (last?.role === 'agent') {
        last.text = [last.text, text].filter(Boolean).join('\n\n');
        last.tools.push(...tools);
      } else {
        entries.push({ role: 'agent', text, tools });
      }
    }
  }
  return entries;
}

/**
 * Returns the interrupts the last message is still waiting on, if the
 * session stopped on one.
 * @param messages Messages from a session snapshot.
 */
export function pendingInterrupts(messages: MessageData[]): PendingInterrupt[] {
  const last = messages[messages.length - 1];
  if (last?.role !== 'model') return [];
  return last.content.filter(isInterrupt).flatMap((p) =>
    p.toolRequest
      ? [
          {
            name: p.toolRequest.name,
            ref: p.toolRequest.ref,
            input: p.toolRequest.input,
          },
        ]
      : [],
  );
}

/** Loading a session failed; `cause` holds the client error. */
export class SessionLoadError extends Error {
  /**
   * @param sessionId The session that failed to load.
   * @param cause The client error.
   */
  constructor(
    readonly sessionId: string,
    cause: unknown,
  ) {
    super(`Could not load session ${sessionId}.`, { cause });
    this.name = 'SessionLoadError';
  }
}

/** A loaded session: what was said, and any interrupt still waiting. */
export interface LoadedSession {
  history: HistoryEntry[];
  pending: PendingInterrupt[];
}

/** The conversation operations the chat screens use. */
export interface ChatSession {
  /** The current session id. A new session has none until its first turn. */
  readonly sessionId: string | undefined;
  /** Starts a new, empty session. */
  newSession(): void;
  /**
   * Switches to an existing session. When `signal` aborts first, it rejects
   * with the signal's reason and keeps the current session.
   */
  loadSession(sessionId: string, signal?: AbortSignal): Promise<LoadedSession>;
  /** Reloads the current session from the server, for example after a 409. */
  reload(): Promise<void>;
  /** Runs one turn and streams it to `handlers`. */
  runTurn(input: TurnInput, handlers?: TurnHandlers): Promise<TurnOutcome>;
}

/** Options for {@link ChatCore}. */
export interface ChatCoreOptions {
  url: string;
  tokens: TokenSource;
  /** Records the last session per URL and user when given. */
  store?: ConfigStore;
  /** An agent client to use instead of `remoteAgent` for `url`. */
  agent?: AgentAPI;
}

/**
 * Runs a conversation with a remote agent: turns, streaming, interrupts and
 * session switching. It holds no UI state.
 */
export class ChatCore implements ChatSession {
  private readonly agent: AgentAPI;
  private chat: AgentChat;
  /** Set after a local abort: the server may have moved the session on. */
  private stale = false;

  /** @param opts See {@link ChatCoreOptions}. */
  constructor(private readonly opts: ChatCoreOptions) {
    this.agent =
      opts.agent ??
      remoteAgent({
        url: opts.url,
        headers: async () => ({
          Authorization: `Bearer ${await opts.tokens.getIdToken()}`,
        }),
      });
    this.chat = this.agent.chat();
  }

  /** The current session id. A new session has none until its first turn. */
  get sessionId(): string | undefined {
    return this.chat.sessionId;
  }

  /** Starts a new, empty session. */
  newSession(): void {
    this.chat = this.agent.chat();
    this.stale = false;
  }

  /**
   * Switches to an existing session and returns its history.
   * @param sessionId The session to load.
   * @param signal Abandons the load; the current session stays.
   */
  async loadSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<LoadedSession> {
    let chat: AgentChat;
    try {
      chat = await this.agent.loadChat({ sessionId });
    } catch (err) {
      throw new SessionLoadError(sessionId, err);
    }
    signal?.throwIfAborted();
    this.chat = chat;
    this.stale = false;
    await this.remember();
    return {
      history: historyEntries(chat.messages),
      pending: pendingInterrupts(chat.messages),
    };
  }

  /**
   * Reloads the current session from the server, for example after a 409.
   * Starts a new session when the current one has no id yet.
   */
  async reload(): Promise<void> {
    if (this.sessionId) await this.loadSession(this.sessionId);
    else this.newSession();
  }

  /**
   * Runs one turn and streams it to `handlers`. Rejects with the client error
   * when the turn fails; see `explain` in `errors.ts`.
   * @param input A message, or responses to pending interrupts.
   * @param handlers Streaming callbacks and an abort signal.
   */
  async runTurn(
    input: TurnInput,
    handlers: TurnHandlers = {},
  ): Promise<TurnOutcome> {
    if (this.stale) await this.reload();
    const turn = this.chat.sendStream(
      'message' in input
        ? input.message
        : {
            resume: {
              respond: input.respond.map((r) =>
                respondPart(r.interrupt, r.output),
              ),
            },
          },
      { abortSignal: handlers.signal },
    );
    let text = '';
    let lastIndex: number | undefined;
    const requested: { name: string; ref?: string }[] = [];
    for await (const chunk of turn.stream) {
      const fromModel = chunk.raw.modelChunk?.role === 'model';
      for (const { toolRequest } of fromModel ? chunk.toolRequests : []) {
        requested.push(toolRequest);
        handlers.onToolCall?.(toolRequest.name);
      }
      if (!chunk.text) continue;
      const index = chunk.raw.modelChunk?.index;
      if (text && index !== undefined && index !== lastIndex) text += '\n\n';
      lastIndex = index;
      text += chunk.text;
      handlers.onText?.(text);
    }
    const response = await turn.response;
    await this.remember();
    const interrupts = response.interrupts.map(({ name, ref, input }) => ({
      name,
      ref,
      input,
    }));
    const tools = requested
      .filter(
        (t) => !interrupts.some((i) => i.name === t.name && i.ref === t.ref),
      )
      .map((t) => t.name);
    if (response.finishReason === 'aborted') {
      this.stale = this.sessionId !== undefined;
      return { status: 'aborted', text, tools };
    }
    if (!text) text = response.text;
    if (response.finishReason === 'interrupted') {
      return { status: 'interrupted', text, tools, interrupts };
    }
    return { status: 'done', text, tools };
  }

  private async remember(): Promise<void> {
    const { store, url, tokens } = this.opts;
    if (store && this.sessionId)
      await store.setLastSession(url, tokens.user.uid, this.sessionId);
  }
}
