import type { Key } from 'ink';

/** The text of a single-line input and the cursor position in it. */
export interface EditState {
  value: string;
  cursor: number;
}

/** What a key press does to a {@link EditState}. */
export type EditResult =
  | { kind: 'edit'; state: EditState }
  | { kind: 'submit' }
  | { kind: 'ignore' };

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c: string | undefined) => !!c && /\s/.test(c);

/** Start of the word before `cursor`; words are runs of letters and digits. */
export function wordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(value[i - 1])) i--;
  while (i > 0 && isWordChar(value[i - 1])) i--;
  return i;
}

/** End of the word after `cursor`; words are runs of letters and digits. */
export function wordEnd(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && !isWordChar(value[i])) i++;
  while (i < value.length && isWordChar(value[i])) i++;
  return i;
}

/** Start of the whitespace-delimited word before `cursor`, as Ctrl+W uses. */
export function bigWordStart(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && isSpace(value[i - 1])) i--;
  while (i > 0 && !isSpace(value[i - 1])) i--;
  return i;
}

const move = ({ value }: EditState, cursor: number): EditResult => ({
  kind: 'edit',
  state: { value, cursor: Math.max(0, Math.min(value.length, cursor)) },
});

const remove = ({ value }: EditState, from: number, to: number): EditResult =>
  from === to
    ? { kind: 'ignore' }
    : {
        kind: 'edit',
        state: { value: value.slice(0, from) + value.slice(to), cursor: from },
      };

/**
 * Applies one key press, as parsed by Ink's `useInput`, with readline-style
 * editing. Ctrl+C, Escape, Tab and the up and down arrows are ignored so the
 * surrounding screen can use them.
 * @param state The current text and cursor.
 * @param input The `input` argument of the `useInput` handler.
 * @param key The `key` argument of the `useInput` handler.
 */
export function applyKey(
  state: EditState,
  input: string,
  key: Partial<Key>,
): EditResult {
  const { value, cursor } = state;
  if (key.return) return { kind: 'submit' };
  if (
    key.escape ||
    key.tab ||
    key.upArrow ||
    key.downArrow ||
    key.pageUp ||
    key.pageDown
  )
    return { kind: 'ignore' };

  if (key.backspace) {
    if (key.super) return remove(state, 0, cursor);
    if (key.meta || key.ctrl)
      return remove(state, wordStart(value, cursor), cursor);
    return remove(state, Math.max(0, cursor - 1), cursor);
  }
  if (key.delete) {
    if (key.meta || key.ctrl)
      return remove(state, cursor, wordEnd(value, cursor));
    return remove(state, cursor, Math.min(value.length, cursor + 1));
  }
  if (key.leftArrow) {
    if (key.super) return move(state, 0);
    if (key.meta || key.ctrl) return move(state, wordStart(value, cursor));
    return move(state, cursor - 1);
  }
  if (key.rightArrow) {
    if (key.super) return move(state, value.length);
    if (key.meta || key.ctrl) return move(state, wordEnd(value, cursor));
    return move(state, cursor + 1);
  }
  if (key.home) return move(state, 0);
  if (key.end) return move(state, value.length);

  if (key.ctrl) {
    switch (input) {
      case 'a':
        return move(state, 0);
      case 'e':
        return move(state, value.length);
      case 'b':
        return move(state, cursor - 1);
      case 'f':
        return move(state, cursor + 1);
      case 'u':
        return remove(state, 0, cursor);
      case 'k':
        return remove(state, cursor, value.length);
      case 'w':
        return remove(state, bigWordStart(value, cursor), cursor);
      case 'd':
        return remove(state, cursor, Math.min(value.length, cursor + 1));
      default:
        return { kind: 'ignore' };
    }
  }
  if (key.meta) {
    switch (input) {
      case 'b':
        return move(state, wordStart(value, cursor));
      case 'f':
        return move(state, wordEnd(value, cursor));
      case 'd':
        return remove(state, cursor, wordEnd(value, cursor));
      default:
        return { kind: 'ignore' };
    }
  }

  const text = [...input.replace(/\r\n|\r|\n/g, ' ')]
    .filter((c) => c >= ' ' && c !== '\x7f')
    .join('');
  if (!text) return { kind: 'ignore' };
  return {
    kind: 'edit',
    state: {
      value: value.slice(0, cursor) + text + value.slice(cursor),
      cursor: cursor + text.length,
    },
  };
}
