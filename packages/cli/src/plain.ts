import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  type ChatSession,
  type DetachedOutcome,
  type InterruptAnswer,
  isRestartableApproval,
  type PendingInterrupt,
  type TurnInput,
} from './chat.js';
import { explain, type Problem } from './errors.js';
import {
  answerError,
  approvalDetails,
  approvalOutput,
  describeAnswer,
  describeDetached,
  formatJson,
  helpLines,
  parseCommand,
  parseJsonInput,
} from './format.js';

/** Options for {@link runPlain}. */
export interface PlainOptions {
  core: ChatSession;
  agentName: string;
  user: string;
  input: Readable;
  output: Writable;
  /** Where problems go; usually stderr. */
  errors: Writable;
  resume?: string;
  /** Turns an error into advice; defaults to `explain`. */
  explainError?: (err: unknown) => Problem;
}

/**
 * Formats a problem as plain text lines.
 * @param problem The explained failure.
 */
export function problemLines(problem: Problem): string[] {
  return [
    `error: ${problem.title}`,
    ...(problem.detail ? [`  ${problem.detail}`] : []),
    `  -> ${problem.hint}`,
  ];
}

/**
 * Runs the chat without a TUI, for piped input or output. Each input line is
 * a message or a command. An interrupt reads its answer from the next line:
 * `approve`, `deny`, or a JSON value (a JSON object for a restartable
 * approval). After a 409, `retry` reloads the session and sends the last
 * input again. Problems go to `errors`.
 * @param opts See {@link PlainOptions}.
 * @returns 0 when every turn and load succeeded, otherwise 1.
 */
export async function runPlain(opts: PlainOptions): Promise<number> {
  const { core, output } = opts;
  const write = (line = '') => output.write(`${line}\n`);
  let failed = false;
  const report = (err: unknown) => {
    failed = true;
    const problem = (opts.explainError ?? explain)(err);
    for (const line of problemLines(problem)) opts.errors.write(`${line}\n`);
    return problem;
  };
  const lines = createInterface({ input: opts.input, terminal: false });
  // Created before the first await: readline drops lines read before then.
  const queue = lines[Symbol.asyncIterator]();
  let pending: PendingInterrupt[] = [];
  let answers: InterruptAnswer[] = [];
  let retry: TurnInput | { detach: string } | undefined;
  let shownSession: string | undefined;

  const askNext = () => {
    const next = pending[0];
    if (!next) return;
    write(`approval needed: ${next.name}`);
    const details = approvalDetails(next);
    if (details) {
      write('  request:');
      for (const line of formatJson(details).split('\n')) write(`    ${line}`);
    }
    for (const line of formatJson(next.input).split('\n')) write(`  ${line}`);
    write(
      isRestartableApproval(next)
        ? '  the tool runs again with your answer: approve | deny | <JSON object>'
        : '  answer with: approve | deny | <JSON>',
    );
  };

  const run = async (input: TurnInput) => {
    retry = undefined;
    let printed = 0;
    output.write(`${opts.agentName}> `);
    try {
      const outcome = await core.runTurn(input, {
        onText: (text) => {
          output.write(text.slice(printed));
          printed = text.length;
        },
        onToolCall: (name) => output.write(`[called ${name}] `),
      });
      if (printed < outcome.text.length)
        output.write(outcome.text.slice(printed));
      write();
      if (outcome.status === 'interrupted') {
        pending = outcome.interrupts;
        answers = [];
        askNext();
      }
    } catch (err) {
      write();
      if (report(err).kind === 'busy') {
        retry = input;
        opts.errors.write(
          '  Type retry to reload the session and send again.\n',
        );
      }
    }
    if (core.sessionId && core.sessionId !== shownSession) {
      shownSession = core.sessionId;
      write(`session: ${core.sessionId}`);
    }
  };

  const settle = async (
    wait: () => Promise<DetachedOutcome>,
    input?: { detach: string },
  ) => {
    retry = undefined;
    try {
      const outcome = await wait();
      if (outcome.text) write(`${opts.agentName}> ${outcome.text}`);
      write(describeDetached(outcome).text);
      if (outcome.interrupts?.length) {
        pending = outcome.interrupts;
        answers = [];
        askNext();
      }
    } catch (err) {
      if (report(err).kind === 'busy' && input) {
        retry = input;
        opts.errors.write(
          '  Type retry to reload the session and send again.\n',
        );
      }
    }
    if (core.sessionId && core.sessionId !== shownSession) {
      shownSession = core.sessionId;
      write(`session: ${core.sessionId}`);
    }
  };

  const detach = (message: string) =>
    settle(
      () =>
        core.detach(message, {
          onDetached: (snapshotId) =>
            write(`detached turn ${snapshotId} running, waiting for it`),
        }),
      { detach: message },
    );

  const load = async (sessionId: string) => {
    try {
      const {
        history,
        pending: open,
        running,
        expired,
      } = await core.loadSession(sessionId);
      shownSession = core.sessionId;
      write(`resumed session ${sessionId}`);
      for (const entry of history) {
        write(
          entry.role === 'user'
            ? `you> ${entry.text}`
            : `${opts.agentName}> ${entry.text}`,
        );
      }
      if (running) {
        write(`detached turn ${running} still running, waiting for it`);
        await settle(() => core.waitDetached(running));
        return;
      }
      if (expired) {
        write(
          describeDetached({ snapshotId: expired, status: 'expired' }).text,
        );
      }
      pending = open;
      answers = [];
      askNext();
    } catch (err) {
      report(err);
    }
  };

  write(`fak: ${opts.agentName} as ${opts.user}`);
  if (opts.resume) await load(opts.resume);

  for (let next = await queue.next(); !next.done; next = await queue.next()) {
    const line = next.value.trim();
    if (!line) continue;
    const current = pending[0];
    if (current) {
      let answer: unknown;
      if (line === 'approve') answer = approvalOutput(true);
      else if (line === 'deny') answer = approvalOutput(false);
      else {
        const parsed = parseJsonInput(line);
        const invalid = parsed.ok
          ? answerError(current, parsed.value)
          : undefined;
        if (!parsed.ok || invalid !== undefined) {
          opts.errors.write(`${parsed.ok ? invalid : parsed.error}\n`);
          continue;
        }
        answer = parsed.value;
      }
      write(describeAnswer(current.name, answer).text);
      answers.push({ interrupt: current, output: answer });
      pending = pending.slice(1);
      if (pending.length) askNext();
      else await run({ answers });
      continue;
    }
    if (line === 'retry' && retry) {
      const input = retry;
      try {
        await core.reload();
        if ('detach' in input) await detach(input.detach);
        else await run(input);
      } catch (err) {
        report(err);
      }
      continue;
    }
    const command = parseCommand(line);
    switch (command.name) {
      case 'message':
        await run({ message: command.text });
        break;
      case 'detach':
        await detach(command.text);
        break;
      case 'new':
        core.newSession();
        write('new session');
        break;
      case 'resume':
        await load(command.sessionId);
        break;
      case 'session':
        write(core.sessionId ? `session: ${core.sessionId}` : 'no session yet');
        break;
      case 'help':
        for (const l of helpLines()) write(l);
        break;
      case 'quit':
        lines.close();
        return failed ? 1 : 0;
      case 'invalid':
        opts.errors.write(`${command.message}\n`);
        break;
    }
  }
  return failed ? 1 : 0;
}
