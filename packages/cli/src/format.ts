import {
  isRecord,
  isRestartableApproval,
  type PendingInterrupt,
} from './chat.js';

/** What a line typed in the chat means. */
export type Command =
  | { name: 'message'; text: string }
  | { name: 'detach'; text: string }
  | { name: 'new' }
  | { name: 'resume'; sessionId: string }
  | { name: 'session' }
  | { name: 'help' }
  | { name: 'quit' }
  | { name: 'invalid'; message: string };

/** Slash commands with their help text, in display order. */
export const COMMANDS: readonly { usage: string; help: string }[] = [
  { usage: '/new', help: 'Start a new session' },
  {
    usage: '/detach <message>',
    help: 'Run a turn in the background and wait for it',
  },
  { usage: '/resume <id>', help: 'Switch to an existing session' },
  { usage: '/session', help: 'Show the current session id' },
  { usage: '/help', help: 'Show commands and keys' },
  { usage: '/quit, /exit', help: 'Exit (or press Ctrl+C at the prompt)' },
  { usage: '//text', help: 'Send a message that starts with /' },
];

/**
 * Parses a line typed in the chat. Only the known command names are
 * commands; any other line is a message, and `//` sends a leading `/`.
 * @param line What the user typed.
 */
export function parseCommand(line: string): Command {
  const trimmed = line.trim();
  if (trimmed.startsWith('//'))
    return { name: 'message', text: trimmed.slice(1) };
  const match = /^\/(\S+)\s*(.*)$/.exec(trimmed);
  const arg = match?.[2] ?? '';
  switch (match?.[1]) {
    case 'new':
    case 'session':
    case 'help':
      return { name: match[1] };
    case 'quit':
    case 'exit':
      return { name: 'quit' };
    case 'resume':
      return arg
        ? { name: 'resume', sessionId: arg }
        : { name: 'invalid', message: 'Usage: /resume <session id>' };
    case 'detach':
      return arg
        ? { name: 'detach', text: arg }
        : { name: 'invalid', message: 'Usage: /detach <message>' };
    default:
      return { name: 'message', text: trimmed };
  }
}

/**
 * Returns the end of a streamed line that fits in `maxRows` rows of `width`
 * columns, with a leading ellipsis when it was cut. It keeps half the room
 * spare for word wrap and wide characters. The whole line is still printed
 * once it ends.
 * @param tail The unfinished line.
 * @param width Columns available for text.
 * @param maxRows Rows available for text.
 */
export function tailPreview(
  tail: string,
  width: number,
  maxRows: number,
): string {
  const room = Math.max(1, Math.floor((width * maxRows) / 2) - 1);
  return tail.length <= room + 1 ? tail : `…${tail.slice(-room)}`;
}

/**
 * Describes an agent URL for the header: the host and the function name,
 * which for the kit is the instance id.
 * @param url Agent function URL.
 */
export function describeUrl(url: string): { host: string; name: string } {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    return { host: parsed.host, name: name || parsed.host };
  } catch {
    return { host: url, name: url };
  }
}

/**
 * Pretty-prints a value as JSON for display. Long output is cut to
 * `maxLines` lines.
 * @param value Any JSON value.
 * @param maxLines Most lines to show.
 */
export function formatJson(value: unknown, maxLines = 20): string {
  const text = JSON.stringify(value, null, 2) ?? 'undefined';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return [
    ...lines.slice(0, maxLines),
    `... ${lines.length - maxLines} more lines`,
  ].join('\n');
}

/**
 * Parses a JSON response typed by the user for an interrupt.
 * @param text What the user typed.
 */
export function parseJsonInput(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: 'Type a JSON value.' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Output sent by the approve and deny choices of an interrupt card. */
export const approvalOutput = (approved: boolean) => ({ approved });

/**
 * Returns why `value` cannot answer `interrupt`, or undefined when it can.
 * A restartable approval takes a JSON object: the tool reads it from
 * `context.resumed`, and a value that is not an object would make the tool
 * ask again.
 * @param interrupt The pending interrupt.
 * @param value The parsed JSON the user typed.
 */
export function answerError(
  interrupt: PendingInterrupt,
  value: unknown,
): string | undefined {
  if (!isRestartableApproval(interrupt) || isRecord(value)) return undefined;
  return 'This approval takes a JSON object, for example {"approved": false, "reason": "..."}.';
}

/**
 * Returns what a restartable approval says about itself: its interrupt
 * metadata without `kind`. Undefined for other interrupts, or when nothing
 * is left.
 * @param interrupt The pending interrupt.
 */
export function approvalDetails(
  interrupt: PendingInterrupt,
): Record<string, unknown> | undefined {
  if (!isRestartableApproval(interrupt) || !interrupt.metadata) return;
  const { kind: _kind, ...details } = interrupt.metadata;
  return Object.keys(details).length ? details : undefined;
}

/**
 * Describes how the user answered an interrupt, for the scrollback.
 * @param name Interrupt tool name.
 * @param output The output that was sent.
 */
export function describeAnswer(
  name: string,
  output: unknown,
): { approved?: boolean; text: string } {
  const json = JSON.stringify(output);
  if (json === JSON.stringify(approvalOutput(true)))
    return { approved: true, text: `Approved ${name}` };
  if (json === JSON.stringify(approvalOutput(false)))
    return { approved: false, text: `Denied ${name}` };
  return { text: `Answered ${name} with ${json}` };
}

/** Help text listing commands and keys, one per line. */
export function helpLines(): string[] {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length));
  return [
    ...COMMANDS.map((c) => `${c.usage.padEnd(width)}  ${c.help}`),
    `${'Ctrl+C'.padEnd(width)}  Stop a running reply, or stop waiting for a detached turn`,
  ];
}

/**
 * Describes how a detached turn ended, for the scrollback.
 * @param outcome The settled detached turn.
 */
export function describeDetached(outcome: {
  snapshotId: string;
  status: 'completed' | 'interrupted' | 'failed' | 'aborted' | 'expired';
  detail?: string;
}): { tone: 'success' | 'warning'; text: string } {
  const detail = outcome.detail ? ` ${outcome.detail}` : '';
  switch (outcome.status) {
    case 'completed':
      return { tone: 'success', text: 'Detached turn completed.' };
    case 'interrupted':
      return {
        tone: 'warning',
        text: 'Detached turn stopped. It waits for your answer.',
      };
    case 'aborted':
      return { tone: 'warning', text: `Detached turn aborted.${detail}` };
    case 'failed':
      return { tone: 'warning', text: `Detached turn failed.${detail}` };
    case 'expired':
      return {
        tone: 'warning',
        text: 'The worker of the detached turn stopped. Send a message to continue from the turn before it.',
      };
  }
}
