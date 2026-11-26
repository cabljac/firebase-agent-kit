import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render } from 'ink-testing-library';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { makeTheme } from '../../src/ui/theme.js';
import { frames } from './helpers.js';

// Ink colours through its own chalk instance; force it on so codes appear.
const here = dirname(fileURLToPath(import.meta.url));
const inkDir = realpathSync(join(here, '../../node_modules/ink'));
const chalkUrl = pathToFileURL(
  join(dirname(inkDir), 'chalk/source/index.js'),
).href;
let chalk: { level: number };
let previous = 0;
beforeAll(async () => {
  chalk = (await import(chalkUrl)).default;
  previous = chalk.level;
  chalk.level = 1;
});
afterAll(() => {
  chalk.level = previous;
  vi.unstubAllEnvs();
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches SGR colour codes
const COLOUR = /\x1b\[(?:3[0-7]|9[0-7]|38;)/;

async function renderSample(noColor: boolean) {
  vi.resetModules();
  if (noColor) vi.stubEnv('NO_COLOR', '1');
  else vi.unstubAllEnvs();
  const { ErrorPanel, Message } = await import('../../src/ui/components.js');
  const { LineInput } = await import('../../src/ui/LineInput.js');
  const app = render(
    <>
      <Message speaker="agent" label="agent" text="hi" tools={['t']} />
      <ErrorPanel problem={{ kind: 'busy', title: 'T', hint: 'H' }} />
      <LineInput value="abc" onChange={() => {}} onSubmit={() => {}} />
    </>,
  );
  await frames.settle();
  const frame = app.lastFrame() ?? '';
  app.unmount();
  return frame;
}

test('makeTheme drops every colour when NO_COLOR is set', () => {
  expect(makeTheme({ NO_COLOR: '1' })).toEqual({});
  expect(makeTheme({}).error).toBe('red');
});

test('with colour on, the sample uses colour codes', async () => {
  expect(await renderSample(false)).toMatch(COLOUR);
});

test('NO_COLOR output has no colour codes but keeps inverse, bold and dim', async () => {
  const frame = await renderSample(true);
  expect(frame).not.toMatch(COLOUR);
  expect(frame).toContain('\x1b[7m');
  expect(frame).toContain('\x1b[1m');
  expect(frame).toContain('\x1b[2m');
});
