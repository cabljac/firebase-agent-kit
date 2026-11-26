import { render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  applyKey,
  bigWordStart,
  wordEnd,
  wordStart,
} from '../../src/ui/edit.js';
import { LineInput } from '../../src/ui/LineInput.js';
import { frames } from './helpers.js';

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

function Harness({
  initial,
  onSubmit,
  mask,
}: {
  initial: string;
  onSubmit: (v: string) => void;
  mask?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <LineInput
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      mask={mask}
    />
  );
}

/** Types `initial`, then each byte sequence in order, then Enter. */
async function typeInto(initial: string, ...sequences: string[]) {
  const onSubmit = vi.fn<(value: string) => void>();
  const app = render(<Harness initial="" onSubmit={onSubmit} />);
  unmounts.push(app.unmount);
  await frames.settle();
  if (initial) {
    app.stdin.write(initial);
    await frames.settle();
  }
  for (const seq of sequences) {
    app.stdin.write(seq);
    await frames.settle();
  }
  app.stdin.write('\r');
  await frames.settle();
  return onSubmit.mock.calls.at(-1)?.[0];
}

test.each([
  ['Backspace (DEL 0x7f)', '\x7f', 'hello worl'],
  ['Ctrl+H or Shift+Backspace (BS 0x08)', '\b', 'hello worl'],
  ['Option+Backspace (ESC DEL)', '\x1b\x7f', 'hello '],
  ['Ctrl+W', '\x17', 'hello '],
  ['Cmd+Backspace or Ctrl+U (0x15)', '\x15', ''],
])('%s edits at the end of the line', async (_name, seq, expected) => {
  expect(await typeInto('hello world', seq)).toBe(expected);
});

test.each([
  ['Ctrl+A', '\x01', 'Xhello world'],
  ['Home (CSI H)', '\x1b[H', 'Xhello world'],
  ['Option+Left (ESC b)', '\x1bb', 'hello Xworld'],
  ['Option+Left (CSI 1;3D)', '\x1b[1;3D', 'hello Xworld'],
  ['Ctrl+Left (CSI 1;5D)', '\x1b[1;5D', 'hello Xworld'],
  ['Left (CSI D)', '\x1b[D', 'hello worlXd'],
])('%s moves the cursor', async (_name, seq, expected) => {
  expect(await typeInto('hello world', seq, 'X')).toBe(expected);
});

test.each([
  ['Ctrl+E', '\x05'],
  ['End (CSI F)', '\x1b[F'],
])('%s moves to the end', async (_name, seq) => {
  expect(await typeInto('hello world', '\x01', seq, 'X')).toBe('hello worldX');
});

test('Option+Right (ESC f and CSI 1;3C) moves by word', async () => {
  expect(await typeInto('hello big world', '\x01', '\x1bf', 'X')).toBe(
    'helloX big world',
  );
  expect(await typeInto('hello big world', '\x01', '\x1b[1;3C', 'X')).toBe(
    'helloX big world',
  );
});

test('Ctrl+U deletes to the line start and Ctrl+K to the end', async () => {
  expect(await typeInto('hello world', '\x1bb', '\x15')).toBe('world');
  expect(await typeInto('hello world', '\x1bb', '\x0b')).toBe('hello ');
});

test('Delete (CSI 3~) deletes forward', async () => {
  expect(await typeInto('hello', '\x01', '\x1b[3~')).toBe('ello');
});

test('pasted newlines become spaces', async () => {
  expect(await typeInto('one\ntwo')).toBe('one two');
});

test('a mask hides the typed characters', async () => {
  const app = render(<Harness initial="" onSubmit={vi.fn()} mask="*" />);
  unmounts.push(app.unmount);
  await frames.settle();
  app.stdin.write('secret');
  await frames.settle();
  expect(app.lastFrame()).toContain('******');
  expect(app.lastFrame()).not.toContain('secret');
});

test('word helpers treat punctuation as a boundary', () => {
  expect(wordStart('{"approved": true}', 17)).toBe(13);
  expect(wordEnd('a.b c', 0)).toBe(1);
  expect(bigWordStart('one two.three', 13)).toBe(4);
});

test('applyKey leaves Escape, Tab, arrows and Ctrl+C to the screen', () => {
  const state = { value: 'x', cursor: 1 };
  expect(applyKey(state, '', { escape: true }).kind).toBe('ignore');
  expect(applyKey(state, '', { tab: true }).kind).toBe('ignore');
  expect(applyKey(state, '', { upArrow: true }).kind).toBe('ignore');
  expect(applyKey(state, 'c', { ctrl: true }).kind).toBe('ignore');
});

test('applyKey treats a super Backspace (kitty Cmd+Backspace) as delete to start', () => {
  expect(
    applyKey({ value: 'ab cd', cursor: 5 }, '', {
      backspace: true,
      super: true,
    }),
  ).toEqual({ kind: 'edit', state: { value: '', cursor: 0 } });
});
