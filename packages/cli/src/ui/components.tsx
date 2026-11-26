import { Box, Text, useInput } from 'ink';
import { type ReactNode, useEffect, useState } from 'react';
import type { PendingInterrupt } from '../chat.js';
import type { Problem } from '../errors.js';
import {
  approvalOutput,
  formatJson,
  helpLines,
  parseJsonInput,
} from '../format.js';
import { LineInput } from './LineInput.js';
import { glyphs, theme } from './theme.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A slow, dim spinner with a label. It rotates; it never blinks. */
export function Spinner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER.length),
      120,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <Text dimColor>
      {SPINNER[frame]} {label}
    </Text>
  );
}

/** What the header shows about the agent and the user. */
export interface HeaderInfo {
  agentName: string;
  host: string;
  user: string;
  version: string;
  /** Set when the target came from a Firebase project directory. */
  project?: string;
  /** The Auth emulator host, when `FIREBASE_AUTH_EMULATOR_HOST` is set. */
  authEmulator?: string;
}

/** The banner printed once at the top of the chat. */
export function Header({
  agentName,
  host,
  user,
  version,
  project,
  authEmulator,
}: HeaderInfo) {
  const row = (label: string, value: string) => (
    <Box>
      <Box width={9} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
      marginBottom={1}
    >
      <Box marginBottom={1}>
        <Text color={theme.brand} bold>
          {glyphs.brand} fak
        </Text>
        <Text dimColor> v{version}</Text>
      </Box>
      {row('agent', agentName)}
      {project && row('project', project)}
      {row('host', host)}
      {row('user', user)}
      {authEmulator && row('auth', `Auth emulator at ${authEmulator}`)}
    </Box>
  );
}

/** Props for {@link Message}. */
export interface MessageProps {
  speaker: 'user' | 'agent';
  label: string;
  text: string;
  tools?: string[];
  /** Shown after the label, for example a spinner while streaming. */
  status?: ReactNode;
}

/** The bar-prefixed body of a message: tool calls, then text. */
export function MessageBody({
  speaker,
  text,
  tools = [],
}: {
  speaker: 'user' | 'agent';
  text: string;
  tools?: string[];
}) {
  if (!text && tools.length === 0) return null;
  const color = speaker === 'user' ? theme.user : theme.agent;
  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={color}
      borderDimColor
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
    >
      {tools.map((name, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a tool can be called twice
        <Text key={i} color={theme.tool} dimColor>
          {glyphs.tool} called {name}
        </Text>
      ))}
      {text && <Text>{text.replace(/^$/gm, ' ')}</Text>}
    </Box>
  );
}

/** One message, with a coloured label and a matching bar on the left. */
export function Message({
  speaker,
  label,
  text,
  tools = [],
  status,
}: MessageProps) {
  const color = speaker === 'user' ? theme.user : theme.agent;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={2}>
        <Text color={color} bold>
          {label}
        </Text>
        {status}
      </Box>
      <MessageBody speaker={speaker} text={text} tools={tools} />
    </Box>
  );
}

/** Tone of a {@link Notice}. */
export type NoticeTone = 'info' | 'success' | 'warning';

/** A one-line status message, such as a session change. */
export function Notice({ tone, text }: { tone: NoticeTone; text: string }) {
  const glyph = tone === 'success' ? glyphs.success : glyphs[tone];
  const color = theme[tone];
  return (
    <Box marginBottom={1}>
      <Text color={color} bold={tone !== 'info'}>
        {glyph}{' '}
      </Text>
      <Text dimColor={tone === 'info'}>{text}</Text>
    </Box>
  );
}

/** A failure, with the server's message and what to do next. */
export function ErrorPanel({ problem }: { problem: Problem }) {
  const color = problem.kind === 'busy' ? theme.warning : theme.error;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
    >
      <Text bold>
        <Text color={color}>
          {problem.kind === 'busy' ? glyphs.warning : glyphs.error}
        </Text>{' '}
        {problem.title}
      </Text>
      {problem.detail && <Text dimColor>{problem.detail}</Text>}
      <Text>
        <Text color={color}>{glyphs.arrow}</Text> {problem.hint}
      </Text>
    </Box>
  );
}

/** The list of slash commands and keys. */
export function HelpPanel() {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text bold>Commands</Text>
      {helpLines().map((line) => (
        <Text key={line} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}

/** A key hint such as `[a] Approve`. */
export function Key({ k, label }: { k: string; label: string }) {
  return (
    <Box flexShrink={0}>
      <Text>
        <Text bold>[{k}]</Text> {label}
      </Text>
    </Box>
  );
}

/** A row of {@link Key} hints that wraps between hints, never inside one. */
export function KeyRow({ children }: { children: ReactNode }) {
  return (
    <Box flexWrap="wrap" columnGap={3}>
      {children}
    </Box>
  );
}

/** Props for {@link InterruptCard}. */
export interface InterruptCardProps {
  interrupt: PendingInterrupt;
  /** Position of this interrupt among those the turn paused on. */
  position: { index: number; total: number };
  /** Called with the tool output the user chose. */
  onAnswer: (output: unknown) => void;
  /** Called when the user presses Esc to leave the card unanswered. */
  onLeave: () => void;
}

/**
 * Asks the user to answer an interrupt: approve, deny, or type a JSON
 * response for tools whose output is not an approval.
 */
export function InterruptCard({
  interrupt,
  position,
  onAnswer,
  onLeave,
}: InterruptCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
        setError(undefined);
      }
      return;
    }
    if (key.escape) onLeave();
    else if (input === 'a') onAnswer(approvalOutput(true));
    else if (input === 'd') onAnswer(approvalOutput(false));
    else if (input === 'e') setEditing(true);
  });

  const submit = (text: string) => {
    const parsed = parseJsonInput(text);
    if (parsed.ok) onAnswer(parsed.value);
    else setError(parsed.error);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text bold>
          <Text color={theme.warning}>{glyphs.warning}</Text> Approval needed
        </Text>
        {position.total > 1 && (
          <Text dimColor>
            {position.index + 1} of {position.total}
          </Text>
        )}
      </Box>
      <Box marginTop={1} gap={1}>
        <Text dimColor>tool</Text>
        <Text bold>{interrupt.name}</Text>
      </Box>
      {interrupt.input !== undefined && (
        <Box flexDirection="column">
          <Text dimColor>input</Text>
          <Box paddingLeft={2}>
            <Text>{formatJson(interrupt.input)}</Text>
          </Box>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {editing ? (
          <>
            <Box>
              <Text bold>response {glyphs.prompt} </Text>
              <LineInput
                value={draft}
                onChange={(value) => {
                  setDraft(value);
                  setError(undefined);
                }}
                onSubmit={submit}
                placeholder='{"approved": true}'
              />
            </Box>
            {error ? (
              <Text color={theme.error}>{error}</Text>
            ) : (
              <Text dimColor>Enter sends this JSON. Esc goes back.</Text>
            )}
          </>
        ) : (
          <>
            <KeyRow>
              <Key k="a" label="Approve" />
              <Key k="d" label="Deny" />
              <Key k="e" label="Respond with JSON" />
              <Key k="esc" label="Later" />
            </KeyRow>
            <Text dimColor>
              Approve sends {JSON.stringify(approvalOutput(true))}, deny sends{' '}
              {JSON.stringify(approvalOutput(false))}.
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}

/** Props for {@link StatusBar}. */
export interface StatusBarProps {
  agentName: string;
  user: string;
  sessionId?: string;
}

/** The line under the prompt with the agent, user and session id. */
export function StatusBar({ agentName, user, sessionId }: StatusBarProps) {
  return (
    <Text wrap="truncate-end">
      <Text color={theme.brand}>{glyphs.brand}</Text>
      <Text dimColor>
        {' '}
        session {sessionId ?? 'new'} · {agentName} · {user}
      </Text>
    </Text>
  );
}
