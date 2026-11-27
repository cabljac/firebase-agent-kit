import {
  type AgentAPI,
  type AgentChat,
  type MessageData,
  remoteAgent,
  type SessionSnapshot,
  type ToolRequestPart,
  type ToolResponsePart,
} from 'genkit/beta/client';
import type { TokenSource } from './auth.js';
import type { ConfigStore } from './store.js';

/** A tool call the agent paused on, waiting for the user's response. */
export interface PendingInterrupt {
  name: string;
  ref?: string;
  input: unknown;
  /** The object the tool passed to `interrupt(metadata)`, if any. */
  metadata?: Record<string, unknown>;
}

/**
 * The user's answer to one interrupt. For a restartable approval, `output`
 * becomes the tool's `context.resumed`; otherwise it is the tool output.
 */
export interface InterruptAnswer {
  interrupt: PendingInterrupt;
  output: unknown;
}

/** What the user sends: a new message, or answers to interrupts. */
export type TurnInput = { message: string } | { answers: InterruptAnswer[] };

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
 * True when `value` is a JSON object: not null and not an array.
 * @param value Any value.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toPending(part: ToolRequestLike): PendingInterrupt[] {
  if (!part.toolRequest) return [];
  const { name, ref, input } = part.toolRequest;
  const metadata = part.metadata?.interrupt;
  return [{ name, ref, input, ...(isRecord(metadata) && { metadata }) }];
}

/**
 * True when `interrupt` is a restartable approval: a tool called
 * `interrupt({ kind: 'approval', ... })` and runs again when the client
 * restarts it with `{ approved }` in `context.resumed`.
 * @param interrupt The pending interrupt.
 */
export const isRestartableApproval = (interrupt: PendingInterrupt) =>
  interrupt.metadata?.kind === 'approval';

const unsettled = (status: SessionSnapshot['status']) =>
  status === 'pending' || status === 'aborting' || status === 'expired';

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
 * Builds the resume part that runs the interrupted tool again with
 * `resumed` in its `context.resumed`. The input must stay as it was: the
 * server rejects a restart whose input differs from the original request.
 * @param interrupt The pending interrupt.
 * @param resumed What the tool reads from `context.resumed`.
 */
export function restartPart(
  interrupt: PendingInterrupt,
  resumed: Record<string, unknown>,
): ToolRequestPart {
  return {
    toolRequest: {
      name: interrupt.name,
      ...(interrupt.ref !== undefined && { ref: interrupt.ref }),
      input: interrupt.input,
    },
    metadata: { resumed },
  };
}

/**
 * Builds the `resume` payload for `answers`: a `restart` entry for each
 * restartable approval and a `respond` entry for every other interrupt.
 * Throws when the answer to a restartable approval is not a JSON object.
 * @param answers The user's answers, one per pending interrupt.
 */
export function resumePayload(answers: InterruptAnswer[]): {
  respond?: ToolResponsePart[];
  restart?: ToolRequestPart[];
} {
  const respond: ToolResponsePart[] = [];
  const restart: ToolRequestPart[] = [];
  for (const { interrupt, output } of answers) {
    if (!isRestartableApproval(interrupt)) {
      respond.push(respondPart(interrupt, output));
    } else if (isRecord(output)) {
      restart.push(restartPart(interrupt, output));
    } else {
      throw new Error(
        `The answer to the approval ${interrupt.name} must be a JSON object.`,
      );
    }
  }
  return {
    ...(respond.length > 0 && { respond }),
    ...(restart.length > 0 && { restart }),
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
  return last.content.filter(isInterrupt).flatMap(toPending);
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

/** Waiting for a detached turn failed; `cause` holds the client error. */
export class SnapshotReadError extends Error {
  /**
   * @param snapshotId The snapshot that was being read.
   * @param cause The client error.
   */
  constructor(
    readonly snapshotId: string,
    cause: unknown,
  ) {
    super(`Could not read snapshot ${snapshotId}.`, { cause });
    this.name = 'SnapshotReadError';
  }
}

/** A loaded session: what was said, and any interrupt still waiting. */
export interface LoadedSession {
  history: HistoryEntry[];
  pending: PendingInterrupt[];
  /** The snapshot id of a detached turn that is still running. */
  running?: string;
  /** The snapshot id of a detached turn whose worker stopped. */
  expired?: string;
}

/** How a detached turn ended. */
export interface DetachedOutcome {
  snapshotId: string;
  status: 'completed' | 'interrupted' | 'failed' | 'aborted' | 'expired';
  /** The agent's last reply, when the turn completed or was interrupted. */
  text: string;
  /** The error message of a failed or aborted turn. */
  detail?: string;
  /** The interrupts an interrupted turn waits on; answer them with `runTurn`. */
  interrupts?: PendingInterrupt[];
}

/** Callbacks for a detached turn. */
export interface DetachHandlers {
  /** Called once the server accepted the turn. */
  onDetached?: (snapshotId: string) => void;
  /** Stops waiting; the turn keeps running on the server. */
  signal?: AbortSignal;
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
  /** Sends `message` as a detached turn and waits until it settles. */
  detach(message: string, handlers?: DetachHandlers): Promise<DetachedOutcome>;
  /** Waits until the detached turn `snapshotId` settles. */
  waitDetached(
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<DetachedOutcome>;
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
    let messages: MessageData[];
    let tip: SessionSnapshot | undefined;
    try {
      tip = await this.agent.getSnapshot({ sessionId });
      if (!tip) throw new Error(`Session ${sessionId} not found.`);
      chat = await this.agent.loadChat({ snapshotId: tip.snapshotId });
      messages = chat.messages;
      if (unsettled(tip.status) && tip.parentId) {
        const parent = await this.agent.getSnapshot(tip.parentId);
        messages = parent?.state?.messages ?? [];
      }
    } catch (err) {
      throw new SessionLoadError(sessionId, err);
    }
    signal?.throwIfAborted();
    this.chat = chat;
    this.stale = false;
    await this.remember();
    const live = tip.status === 'pending' || tip.status === 'aborting';
    return {
      history: historyEntries(messages),
      pending: unsettled(tip.status) ? [] : pendingInterrupts(messages),
      ...(live && { running: tip.snapshotId }),
      ...(tip.status === 'expired' && { expired: tip.snapshotId }),
    };
  }

  /**
   * Sends `message` as a detached turn, then waits until it settles. Rejects
   * with the client error when the server refuses the turn, for example
   * with a 409 while another turn holds the session.
   * @param message The user's message.
   * @param handlers Called when the turn starts; `signal` stops the wait.
   */
  async detach(
    message: string,
    handlers: DetachHandlers = {},
  ): Promise<DetachedOutcome> {
    if (this.stale) await this.reload();
    const task = await this.chat.detach(message);
    this.stale = true;
    await this.remember();
    handlers.onDetached?.(task.snapshotId);
    return this.waitDetached(task.snapshotId, handlers.signal);
  }

  /**
   * Waits until the detached turn `snapshotId` settles, then reloads the
   * session so the next turn continues from it.
   * @param snapshotId The detached turn's snapshot.
   * @param signal Stops waiting; the turn keeps running on the server.
   */
  async waitDetached(
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<DetachedOutcome> {
    this.stale = true;
    let snapshot: SessionSnapshot | undefined;
    try {
      snapshot = await this.agent.waitForSnapshot(snapshotId, {
        abortSignal: signal,
      });
    } catch (err) {
      throw new SnapshotReadError(snapshotId, err);
    }
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found.`);
    const messages = snapshot.state?.messages ?? [];
    const settled =
      snapshot.status === 'failed' ||
      snapshot.status === 'aborted' ||
      snapshot.status === 'expired'
        ? snapshot.status
        : undefined;
    const interrupts = settled ? [] : pendingInterrupts(messages);
    const status = settled ?? (interrupts.length ? 'interrupted' : 'completed');
    const last = messages.at(-1);
    const text =
      !settled && last?.role === 'model'
        ? last.content.map((p) => p.text ?? '').join('')
        : '';
    await this.reload();
    return {
      snapshotId,
      status,
      text,
      ...(snapshot.error?.message && { detail: snapshot.error.message }),
      ...(interrupts.length > 0 && { interrupts }),
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
   * @param input A message, or answers to pending interrupts.
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
        : { resume: resumePayload(input.answers) },
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
    const interrupts = response.toolRequests
      .filter(isInterrupt)
      .flatMap(toPending);
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
