import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatSession,
  HistoryEntry,
  PendingInterrupt,
  TurnInput,
} from '../chat.js';
import { explain, type Problem } from '../errors.js';
import { describeAnswer, parseCommand, tailPreview } from '../format.js';
import {
  ErrorPanel,
  Header,
  type HeaderInfo,
  HelpPanel,
  InterruptCard,
  Key,
  KeyRow,
  Message,
  MessageBody,
  Notice,
  type NoticeTone,
  Spinner,
  StatusBar,
} from './components.js';
import { LineInput } from './LineInput.js';
import { glyphs, theme } from './theme.js';

/** An entry of the scrollback, printed once. */
export type Item =
  | { kind: 'header' }
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string; tools: string[] }
  | { kind: 'agent-label' }
  | { kind: 'agent-body'; text: string; tools: string[] }
  | { kind: 'gap' }
  | { kind: 'notice'; tone: NoticeTone; text: string }
  | { kind: 'answer'; name: string; output: unknown }
  | { kind: 'problem'; problem: Problem }
  | { kind: 'help' };

type Mode =
  | { name: 'input' }
  | { name: 'working'; label: string }
  | { name: 'streaming'; tail: string; tools: string[]; labelShown: boolean }
  | {
      name: 'interrupt';
      pending: PendingInterrupt[];
      answers: { interrupt: PendingInterrupt; output: unknown }[];
    }
  | { name: 'busy'; retry: TurnInput };

/** Props for {@link App}. */
export interface AppProps {
  core: ChatSession;
  header: HeaderInfo;
  /** A session to load on start. */
  resume?: string;
  /** Turns an error into advice; defaults to `explain`. */
  explainError?: (err: unknown) => Problem;
}

/** Rows the live area needs besides the streamed text. */
const CHROME_ROWS = 4;

const rejectOnAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    }),
  );

/** The chat screen. */
export function App({
  core,
  header,
  resume,
  explainError = explain,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [items, setItems] = useState<(Item & { id: number })[]>([
    { kind: 'header', id: 0 },
  ]);
  const initialMode: Mode = resume
    ? { name: 'working', label: 'Loading session' }
    : { name: 'input' };
  const [mode, setModeState] = useState<Mode>(initialMode);
  // Key handlers read the mode from here: two keys can arrive before a render.
  const modeRef = useRef<Mode>(initialMode);
  const setMode = useCallback((next: Mode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);
  const [draft, setDraft] = useState('');
  const [sessionId, setSessionId] = useState(core.sessionId);
  const nextId = useRef(1);
  const turnAbort = useRef<AbortController | undefined>(undefined);
  const loadAbort = useRef<AbortController | undefined>(undefined);

  const push = useCallback((...added: Item[]) => {
    setItems((prev) => [
      ...prev,
      ...added.map((item) => ({ ...item, id: nextId.current++ })),
    ]);
  }, []);

  const fail = useCallback(
    (err: unknown, retry?: TurnInput) => {
      const problem = explainError(err);
      push({ kind: 'problem', problem });
      setMode(
        problem.kind === 'busy' && retry
          ? { name: 'busy', retry }
          : { name: 'input' },
      );
    },
    [push, setMode, explainError],
  );

  const run = useCallback(
    async (input: TurnInput) => {
      const controller = new AbortController();
      turnAbort.current = controller;
      let committed = 0;
      let committedTools = 0;
      let labelShown = false;
      let pendingTools: string[] = [];
      let tail = '';
      const show = () =>
        setMode({ name: 'streaming', tail, tools: pendingTools, labelShown });
      show();
      try {
        const outcome = await core.runTurn(input, {
          signal: controller.signal,
          onText: (text) => {
            const newline = text.lastIndexOf('\n');
            if (newline >= committed) {
              const added: Item[] = labelShown ? [] : [{ kind: 'agent-label' }];
              added.push({
                kind: 'agent-body',
                text: text.slice(committed, newline),
                tools: pendingTools,
              });
              push(...added);
              labelShown = true;
              committedTools += pendingTools.length;
              pendingTools = [];
              committed = newline + 1;
            }
            tail = text.slice(committed);
            show();
          },
          onToolCall: (name) => {
            pendingTools = [...pendingTools, name];
            show();
          },
        });
        setSessionId(core.sessionId);
        const text = outcome.text.slice(committed);
        const tools = outcome.tools.slice(committedTools);
        if (!labelShown) {
          if (text || tools.length) push({ kind: 'agent', text, tools });
        } else {
          if (text || tools.length) push({ kind: 'agent-body', text, tools });
          push({ kind: 'gap' });
        }
        if (outcome.status === 'aborted') {
          push({
            kind: 'notice',
            tone: 'warning',
            text: 'Stopped. The agent may still finish this turn on the server.',
          });
          setMode({ name: 'input' });
        } else if (outcome.status === 'interrupted') {
          setMode({
            name: 'interrupt',
            pending: outcome.interrupts,
            answers: [],
          });
        } else {
          setMode({ name: 'input' });
        }
      } catch (err) {
        setSessionId(core.sessionId);
        if (labelShown) push({ kind: 'gap' });
        fail(err, input);
      } finally {
        turnAbort.current = undefined;
      }
    },
    [core, push, fail, setMode],
  );

  const load = useCallback(
    async (id: string) => {
      const controller = new AbortController();
      loadAbort.current = controller;
      setMode({ name: 'working', label: 'Loading session' });
      const loading = core.loadSession(id, controller.signal);
      loading.catch(() => {});
      try {
        const { history, pending } = await Promise.race([
          loading,
          rejectOnAbort(controller.signal),
        ]);
        setSessionId(core.sessionId);
        push(
          { kind: 'notice', tone: 'success', text: `Resumed session ${id}` },
          ...history.map(historyItem),
        );
        setMode(
          pending.length
            ? { name: 'interrupt', pending, answers: [] }
            : { name: 'input' },
        );
      } catch (err) {
        if (controller.signal.aborted) {
          push({
            kind: 'notice',
            tone: 'warning',
            text: `Stopped loading session ${id}.`,
          });
          setMode({ name: 'input' });
        } else {
          fail(err);
        }
      } finally {
        loadAbort.current = undefined;
      }
    },
    [core, push, fail, setMode],
  );

  const started = useRef(false);
  useEffect(() => {
    if (started.current || !resume) return;
    started.current = true;
    void load(resume);
  }, [resume, load]);

  const submit = (line: string) => {
    if (modeRef.current.name !== 'input') return;
    setDraft('');
    if (!line.trim()) return;
    const command = parseCommand(line);
    if (command.name === 'message') {
      push({ kind: 'user', text: command.text });
      void run({ message: command.text });
      return;
    }
    switch (command.name) {
      case 'new':
        core.newSession();
        setSessionId(undefined);
        push({
          kind: 'notice',
          tone: 'success',
          text: 'New session. It gets an id with your first message.',
        });
        return;
      case 'resume':
        void load(command.sessionId);
        return;
      case 'session':
        push({
          kind: 'notice',
          tone: 'info',
          text: core.sessionId
            ? `Session ${core.sessionId}`
            : 'No session yet. Send a message to start one.',
        });
        return;
      case 'help':
        push({ kind: 'help' });
        return;
      case 'quit':
        exit();
        return;
      case 'invalid':
        push({ kind: 'notice', tone: 'warning', text: command.message });
        return;
    }
  };

  const answer = (output: unknown) => {
    const current = modeRef.current;
    if (current.name !== 'interrupt') return;
    const [first, ...rest] = current.pending;
    if (!first) return;
    const answers = [...current.answers, { interrupt: first, output }];
    push({ kind: 'answer', name: first.name, output });
    if (rest.length) {
      setMode({ ...current, pending: rest, answers });
    } else {
      void run({ respond: answers });
    }
  };

  const leaveInterrupt = () => {
    if (modeRef.current.name !== 'interrupt') return;
    const id = core.sessionId;
    push({
      kind: 'notice',
      tone: 'warning',
      text: id
        ? `Approval left open. Type /resume ${id} to answer it, or /new to start over.`
        : 'Approval left open. Type /new to start over.',
    });
    setMode({ name: 'input' });
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (turnAbort.current) turnAbort.current.abort();
      else if (loadAbort.current) loadAbort.current.abort();
      else exit();
      return;
    }
    const current = modeRef.current;
    if (current.name !== 'busy') return;
    if (input === 'r') {
      const retry = current.retry;
      setMode({ name: 'working', label: 'Reloading session' });
      void core.reload().then(
        () => run(retry),
        (err) => fail(err),
      );
    } else if (key.escape) {
      if ('message' in current.retry) setDraft(current.retry.message);
      setMode({ name: 'input' });
    }
  });

  const width = Math.max(20, dimension(stdout, 'columns', 80) - 4);
  const maxRows = Math.max(1, dimension(stdout, 'rows', 24) - CHROME_ROWS);

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => (
          <Box key={item.id} paddingX={1}>
            <ItemView item={item} header={header} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column" paddingX={1}>
        {mode.name === 'streaming' && (
          <Box flexDirection="column" marginBottom={1}>
            {!mode.labelShown && (
              <Text color={theme.agent} bold>
                {header.agentName}
              </Text>
            )}
            <MessageBody
              speaker="agent"
              text={tailPreview(mode.tail, width, maxRows)}
              tools={mode.tools}
            />
            {!mode.tail && <Spinner label="thinking" />}
          </Box>
        )}
        {mode.name === 'working' && (
          <Box marginBottom={1}>
            <Spinner label={mode.label} />
          </Box>
        )}
        {mode.name === 'interrupt' && mode.pending[0] && (
          <InterruptCard
            key={`${mode.answers.length}`}
            interrupt={mode.pending[0]}
            position={{
              index: mode.answers.length,
              total: mode.answers.length + mode.pending.length,
            }}
            onAnswer={answer}
            onLeave={leaveInterrupt}
          />
        )}
        {mode.name === 'busy' && (
          <Box marginBottom={1}>
            <KeyRow>
              <Key k="r" label="Reload session and send again" />
              <Key k="esc" label="Edit and send later" />
            </KeyRow>
          </Box>
        )}
        {mode.name === 'input' && (
          <Box>
            <Text color={theme.user} bold>
              {glyphs.prompt}{' '}
            </Text>
            <LineInput
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              placeholder="Message the agent, or /help"
            />
          </Box>
        )}
        <StatusBar
          agentName={header.agentName}
          user={header.user}
          sessionId={sessionId}
        />
      </Box>
    </Box>
  );
}

function dimension(
  stream: object,
  name: 'rows' | 'columns',
  fallback: number,
): number {
  const value = name in stream ? Reflect.get(stream, name) : undefined;
  return typeof value === 'number' && value > 0 ? value : fallback;
}

function historyItem(entry: HistoryEntry): Item {
  return entry.role === 'user'
    ? { kind: 'user', text: entry.text }
    : { kind: 'agent', text: entry.text, tools: entry.tools };
}

/** Renders one scrollback entry. */
function ItemView({ item, header }: { item: Item; header: HeaderInfo }) {
  switch (item.kind) {
    case 'header':
      return <Header {...header} />;
    case 'user':
      return <Message speaker="user" label="you" text={item.text} />;
    case 'agent':
      return (
        <Message
          speaker="agent"
          label={header.agentName}
          text={item.text}
          tools={item.tools}
        />
      );
    case 'agent-label':
      return (
        <Text color={theme.agent} bold>
          {header.agentName}
        </Text>
      );
    case 'agent-body':
      return (
        <MessageBody
          speaker="agent"
          text={item.text || ' '}
          tools={item.tools}
        />
      );
    case 'gap':
      return <Text> </Text>;
    case 'notice':
      return <Notice tone={item.tone} text={item.text} />;
    case 'answer': {
      const { approved, text } = describeAnswer(item.name, item.output);
      return (
        <Notice tone={approved === false ? 'warning' : 'success'} text={text} />
      );
    }
    case 'problem':
      return <ErrorPanel problem={item.problem} />;
    case 'help':
      return <HelpPanel />;
  }
}
