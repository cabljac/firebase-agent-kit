import { EventEmitter } from 'node:events';
import { type Instance, render } from 'ink';
import type { ReactElement } from 'react';

/** A fake terminal output that records every write. */
class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  output = '';
  constructor(
    readonly rows: number,
    readonly columns: number,
  ) {
    super();
  }
  readonly writable = true;
  write = (chunk: string, ...rest: unknown[]) => {
    this.output += chunk;
    const done = rest.find((arg) => typeof arg === 'function');
    if (typeof done === 'function') queueMicrotask(() => done());
    return true;
  };
}

/** A fake terminal input that feeds bytes to Ink. */
class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  private data: string | null = null;
  write(data: string) {
    this.data = data;
    this.emit('readable');
  }
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

/** An app rendered in a fake interactive terminal. */
export interface TtyApp {
  instance: Instance;
  stdout: FakeStdout;
  stdin: FakeStdin;
  /** Everything written so far, without escape sequences. */
  text(): string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches escape sequences
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

// Ink only uses write/read, isTTY, rows, columns and events of its streams.
function asStream<T>(fake: EventEmitter): T {
  return fake as unknown as T;
}

/**
 * Renders `tree` like a real terminal session: interactive mode, a TTY with
 * the given size, and Ctrl+C left to the app.
 * @param tree The element to render.
 * @param size Terminal rows and columns.
 */
export function renderTty(
  tree: ReactElement,
  size: { rows: number; columns: number } = { rows: 40, columns: 100 },
): TtyApp {
  const stdout = new FakeStdout(size.rows, size.columns);
  const stdin = new FakeStdin();
  const instance = render(tree, {
    stdout: asStream<NodeJS.WriteStream>(stdout),
    stdin: asStream<NodeJS.ReadStream>(stdin),
    stderr: asStream<NodeJS.WriteStream>(stdout),
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    instance,
    stdout,
    stdin,
    text: () => stdout.output.replace(ANSI, ''),
  };
}
