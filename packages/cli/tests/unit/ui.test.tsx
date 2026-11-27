import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  ErrorPanel,
  InterruptCard,
  Message,
  StatusBar,
} from '../../src/ui/components.js';
import { PasswordPrompt, Picker } from '../../src/ui/prompt.js';
import { frames } from './helpers.js';
import { renderTty } from './tty.js';

const tick = frames.settle;
const unmounts: (() => void)[] = [];
const mount = (node: ReactElement) => {
  const app = render(node);
  unmounts.push(app.unmount);
  return app;
};
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

test('Message shows the label, tool calls and text', () => {
  const { lastFrame } = mount(
    <Message
      speaker="agent"
      label="support"
      text={'Hello\nthere'}
      tools={['getMyProfile']}
    />,
  );
  expect(lastFrame()?.trimEnd()).toBe(
    ['support', '┃ ↳ called getMyProfile', '┃ Hello', '┃ there'].join('\n'),
  );
});

test('Message without text shows only the label', () => {
  const { lastFrame } = mount(<Message speaker="user" label="you" text="" />);
  expect(lastFrame()?.trimEnd()).toBe('you');
});

test('ErrorPanel shows the title, detail and hint', () => {
  const { lastFrame } = mount(
    <ErrorPanel
      problem={{
        kind: 'busy',
        title: 'Session busy',
        detail: 'Another turn is running for this session.',
        hint: 'Wait, then reload.',
      }}
    />,
  );
  const frame = lastFrame() ?? '';
  expect(frame).toContain('! Session busy');
  expect(frame).toContain('Another turn is running for this session.');
  expect(frame).toContain('➜ Wait, then reload.');
  expect(frame.split('\n')[0]).toMatch(/^╭─+╮$/);
});

test('StatusBar shows the session id, or new', () => {
  expect(
    mount(<StatusBar agentName="a" user="u@x" sessionId="s1" />).lastFrame(),
  ).toBe('✦ session s1 · a · u@x');
  expect(mount(<StatusBar agentName="a" user="u@x" />).lastFrame()).toBe(
    '✦ session new · a · u@x',
  );
});

const interrupt = {
  name: 'approveTransfer',
  ref: 'r1',
  input: { amount: 500 },
};

test('InterruptCard shows the tool and its input', () => {
  const { lastFrame } = mount(
    <InterruptCard
      interrupt={interrupt}
      position={{ index: 1, total: 2 }}
      onAnswer={vi.fn()}
      onLeave={vi.fn()}
    />,
  );
  const frame = lastFrame() ?? '';
  expect(frame).toContain('Approval needed');
  expect(frame).toContain('2 of 2');
  expect(frame).toContain('tool approveTransfer');
  expect(frame).toContain('"amount": 500');
  expect(frame).toContain('[a] Approve');
});

test.each([
  ['a', { approved: true }],
  ['d', { approved: false }],
])('InterruptCard key %s answers %j', async (key, output) => {
  const onAnswer = vi.fn();
  const { stdin } = mount(
    <InterruptCard
      interrupt={interrupt}
      position={{ index: 0, total: 1 }}
      onAnswer={onAnswer}
      onLeave={vi.fn()}
    />,
  );
  await tick();
  stdin.write(key);
  await tick();
  expect(onAnswer).toHaveBeenCalledWith(output);
});

test('InterruptCard validates a typed JSON response', async () => {
  const onAnswer = vi.fn();
  const { stdin, lastFrame } = mount(
    <InterruptCard
      interrupt={interrupt}
      position={{ index: 0, total: 1 }}
      onAnswer={onAnswer}
      onLeave={vi.fn()}
    />,
  );
  await tick();
  stdin.write('e');
  await tick();
  expect(lastFrame()).toContain('response ❯');

  stdin.write('{bad');
  await tick();
  stdin.write('\r');
  await tick();
  expect(lastFrame()).toContain('Not valid JSON');
  expect(onAnswer).not.toHaveBeenCalled();

  for (let i = 0; i < 4; i++) {
    stdin.write('\x7f');
    await tick();
  }
  stdin.write('{"note":"ok"}');
  await tick();
  stdin.write('\r');
  await tick();
  expect(onAnswer).toHaveBeenCalledWith({ note: 'ok' });
});

test('InterruptCard Esc calls onLeave', async () => {
  const onLeave = vi.fn();
  const { stdin } = mount(
    <InterruptCard
      interrupt={interrupt}
      position={{ index: 0, total: 1 }}
      onAnswer={vi.fn()}
      onLeave={onLeave}
    />,
  );
  await tick();
  stdin.write('\x1b');
  await frames.until(() => expect(onLeave).toHaveBeenCalled());
});

test('InterruptCard key hints keep each key with its label at 34 columns', () => {
  const app = renderTty(
    <InterruptCard
      interrupt={interrupt}
      position={{ index: 0, total: 1 }}
      onAnswer={vi.fn()}
      onLeave={vi.fn()}
    />,
    { rows: 40, columns: 34 },
  );
  const text = app.text();
  app.instance.unmount();
  expect(text).toContain('[a] Approve');
  expect(text).toContain('[e] Respond with JSON');
  expect(text).not.toMatch(/\[e\]\s*\n/);
});

const approval = {
  name: 'deleteFile',
  ref: 'd1',
  input: { path: '/tmp/x' },
  metadata: { kind: 'approval', action: 'delete /tmp/x' },
};

test('InterruptCard shows a restartable approval with its request', () => {
  const { lastFrame } = mount(
    <InterruptCard
      interrupt={approval}
      position={{ index: 0, total: 1 }}
      onAnswer={vi.fn()}
      onLeave={vi.fn()}
    />,
  );
  const frame = lastFrame() ?? '';
  expect(frame).toContain('Approval needed');
  expect(frame).toContain('tool deleteFile');
  expect(frame).toContain('"action": "delete /tmp/x"');
  expect(frame).not.toContain('"kind"');
  expect(frame).toContain('"path": "/tmp/x"');
  expect(frame).toContain('The tool runs again with your answer.');
  expect(frame).toContain('[e] Answer with JSON');
});

test('InterruptCard takes only a JSON object for a restartable approval', async () => {
  const onAnswer = vi.fn();
  const { stdin, lastFrame } = mount(
    <InterruptCard
      interrupt={approval}
      position={{ index: 0, total: 1 }}
      onAnswer={onAnswer}
      onLeave={vi.fn()}
    />,
  );
  await tick();
  stdin.write('e');
  await tick();
  stdin.write('true');
  await tick();
  stdin.write('\r');
  await tick();
  expect(lastFrame()).toContain('This approval takes a JSON object');
  expect(onAnswer).not.toHaveBeenCalled();

  for (let i = 0; i < 4; i++) {
    stdin.write('\x7f');
    await tick();
  }
  stdin.write('{"approved":false,"reason":"no"}');
  await tick();
  stdin.write('\r');
  await tick();
  expect(onAnswer).toHaveBeenCalledWith({ approved: false, reason: 'no' });
});

test('PasswordPrompt submits the typed password and hides it', async () => {
  const onSubmit = vi.fn();
  const { stdin, lastFrame } = mount(
    <PasswordPrompt email="a@x" onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
  await tick();
  stdin.write('hunter2');
  await tick();
  expect(lastFrame()).toContain('*******');
  expect(lastFrame()).not.toContain('hunter2');
  stdin.write('\r');
  await frames.until(() => expect(onSubmit).toHaveBeenCalledWith('hunter2'));
});

test('PasswordPrompt Ctrl+C cancels', async () => {
  const onCancel = vi.fn();
  const { stdin } = mount(
    <PasswordPrompt email="a@x" onSubmit={vi.fn()} onCancel={onCancel} />,
  );
  await tick();
  stdin.write('\x03');
  await frames.until(() => expect(onCancel).toHaveBeenCalled());
});

test('Picker chooses with the arrow keys or a number', async () => {
  const onPick = vi.fn();
  const { stdin, lastFrame } = mount(
    <Picker
      title="Choose a kit instance"
      options={[{ label: 'support' }, { label: 'sales' }]}
      onPick={onPick}
      onCancel={vi.fn()}
    />,
  );
  await tick();
  expect(lastFrame()).toContain('1. support');
  stdin.write('\x1b[B');
  await tick();
  stdin.write('\r');
  await frames.until(() => expect(onPick).toHaveBeenCalledWith(1));

  const byNumber = vi.fn();
  const second = mount(
    <Picker
      title="t"
      options={[{ label: 'a' }, { label: 'b' }]}
      onPick={byNumber}
      onCancel={vi.fn()}
    />,
  );
  await tick();
  second.stdin.write('2');
  await frames.until(() => expect(byNumber).toHaveBeenCalledWith(1));
});

test('Picker Esc cancels', async () => {
  const onCancel = vi.fn();
  const { stdin } = mount(
    <Picker
      title="t"
      options={[{ label: 'a' }]}
      onPick={vi.fn()}
      onCancel={onCancel}
    />,
  );
  await tick();
  stdin.write('\x1b');
  await frames.until(() => expect(onCancel).toHaveBeenCalled());
});
