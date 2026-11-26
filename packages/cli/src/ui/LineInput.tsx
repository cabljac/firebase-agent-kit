import { Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { applyKey, type EditState } from './edit.js';

/** Props for {@link LineInput}. */
export interface LineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  /** Shows this character for each typed one, for passwords. */
  mask?: string;
  isActive?: boolean;
}

/**
 * A single-line text input with readline-style editing; see `applyKey`. The
 * cursor is drawn with inverse video, so it stays visible without colour.
 */
export function LineInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  mask,
  isActive = true,
}: LineInputProps) {
  // Several keys can arrive before React re-renders, so edits chain on a ref.
  const state = useRef<EditState>({ value, cursor: value.length });
  if (state.current.value !== value) {
    state.current = { value, cursor: value.length };
  }
  const [, rerender] = useState(0);

  useInput(
    (input, key) => {
      const result = applyKey(state.current, input, key);
      if (result.kind === 'submit') {
        onSubmit(state.current.value);
      } else if (result.kind === 'edit') {
        const changed = result.state.value !== state.current.value;
        state.current = result.state;
        if (changed) onChange(result.state.value);
        else rerender((n) => n + 1);
      }
    },
    { isActive },
  );

  const { cursor } = state.current;
  if (!value && placeholder) {
    return (
      <Text>
        <Text inverse>{placeholder[0]}</Text>
        <Text dimColor>{placeholder.slice(1)}</Text>
      </Text>
    );
  }
  const shown = mask ? mask.repeat(value.length) : value;
  return (
    <Text>
      {shown.slice(0, cursor)}
      <Text inverse>{shown[cursor] ?? ' '}</Text>
      {shown.slice(cursor + 1)}
    </Text>
  );
}
