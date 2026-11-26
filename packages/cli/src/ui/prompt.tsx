import { Box, render, Text, useInput } from 'ink';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import type { Problem } from '../errors.js';
import { ErrorPanel } from './components.js';
import { LineInput } from './LineInput.js';
import { glyphs, theme } from './theme.js';

/** Thrown when the user presses Ctrl+C at a prompt. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'CancelledError';
  }
}

/** Props for {@link TextPrompt}. */
export interface TextPromptProps {
  /** The line above the input. */
  title: ReactNode;
  label: string;
  /** Dim text under the input. */
  note?: string;
  /** Shown instead of the prompt once the user submits. */
  doneText: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** A one-line hidden input with a title; used for passwords and API keys. */
export function TextPrompt({
  title,
  label,
  note,
  doneText,
  onSubmit,
  onCancel,
}: TextPromptProps) {
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(false);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') onCancel();
  });
  useEffect(() => {
    if (submitted) onSubmit(value);
  }, [submitted, value, onSubmit]);
  if (submitted) {
    return (
      <Box paddingX={1}>
        <Text dimColor>
          {glyphs.brand} {doneText}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.brand}>{glyphs.brand}</Text> {title}
      </Text>
      <Box>
        <Text color={theme.user} bold>
          {label} {glyphs.prompt}{' '}
        </Text>
        <LineInput
          value={value}
          onChange={setValue}
          onSubmit={(v) => {
            if (v) setSubmitted(true);
          }}
          mask={glyphs.mask}
        />
      </Box>
      {note && <Text dimColor>{note}</Text>}
    </Box>
  );
}

/** Props for {@link PasswordPrompt}. */
export interface PasswordPromptProps {
  email: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/** Hidden input for the account password. */
export function PasswordPrompt({
  email,
  onSubmit,
  onCancel,
}: PasswordPromptProps) {
  return (
    <TextPrompt
      title={
        <>
          Sign in as <Text bold>{email}</Text>
        </>
      }
      label="password"
      note="The password is not saved. A refresh token is kept so you stay signed in."
      doneText={`Signing in as ${email}`}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

/** Props for {@link Picker}. */
export interface PickerProps {
  title: string;
  options: { label: string; hint?: string }[];
  onPick: (index: number) => void;
  onCancel: () => void;
}

/** A list to choose from with the arrow keys and Enter, or a number key. */
export function Picker({ title, options, onPick, onCancel }: PickerProps) {
  const [selected, setSelected] = useState(0);
  const [picked, setPicked] = useState<number>();
  useInput((input, key) => {
    if (picked !== undefined) return;
    if (key.ctrl && input === 'c') onCancel();
    else if (key.escape) onCancel();
    else if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow)
      setSelected((i) => Math.min(options.length - 1, i + 1));
    else if (key.return) setPicked(selected);
    else if (/^[1-9]$/.test(input) && Number(input) <= options.length)
      setPicked(Number(input) - 1);
  });
  useEffect(() => {
    if (picked !== undefined) onPick(picked);
  }, [picked, onPick]);
  if (picked !== undefined) {
    return (
      <Box paddingX={1}>
        <Text dimColor>
          {glyphs.brand} {title}: {options[picked]?.label}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.brand}>{glyphs.brand}</Text> {title}
      </Text>
      {options.map((option, i) => (
        <Text key={option.label} bold={i === selected}>
          {i === selected ? glyphs.prompt : ' '} {i + 1}. {option.label}
          {option.hint && <Text dimColor> {option.hint}</Text>}
        </Text>
      ))}
      <Text dimColor>Up and Down to move, Enter to choose, Esc to cancel.</Text>
    </Box>
  );
}

/**
 * Renders a prompt until it calls back, then unmounts it.
 * @param build Builds the element from the resolve and cancel callbacks.
 */
async function ask<T>(
  build: (resolve: (value: T) => void, cancel: () => void) => ReactElement,
): Promise<T> {
  const box: { outcome?: { value: T } } = {};
  const app = render(
    build(
      (value) => {
        box.outcome = { value };
        app.unmount();
      },
      () => app.unmount(),
    ),
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  if (!box.outcome) throw new CancelledError();
  return box.outcome.value;
}

/**
 * Asks for a password in the terminal, with the input hidden.
 * @param email The account to sign in to.
 */
export function promptPassword(email: string): Promise<string> {
  return ask<string>((resolve, cancel) => (
    <PasswordPrompt email={email} onSubmit={resolve} onCancel={cancel} />
  ));
}

/**
 * Asks for a project's web API key, with the input hidden.
 * @param project Firebase project id.
 */
export function promptApiKey(project: string): Promise<string> {
  return ask<string>((resolve, cancel) => (
    <TextPrompt
      title={`Firebase web API key for ${project}`}
      label="API key"
      note="Find it in the Firebase console under Project settings. It is cached for this project."
      doneText="API key saved"
      onSubmit={resolve}
      onCancel={cancel}
    />
  ));
}

/**
 * Asks the user to choose one of `options`.
 * @param title What is being chosen.
 * @param options The choices.
 * @returns The index of the choice.
 */
export function pickOne(
  title: string,
  options: { label: string; hint?: string }[],
): Promise<number> {
  return ask<number>((resolve, cancel) => (
    <Picker
      title={title}
      options={options}
      onPick={resolve}
      onCancel={cancel}
    />
  ));
}

/**
 * Prints an error panel and waits until it is drawn.
 * @param problem The failure to show.
 */
export async function printProblem(problem: Problem): Promise<void> {
  const app = render(<ErrorPanel problem={problem} />);
  app.unmount();
  await app.waitUntilExit();
}
