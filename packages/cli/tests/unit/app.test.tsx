import { afterEach, expect, test } from 'vitest';
import type { ChatSession, TurnOutcome } from '../../src/chat.js';
import { App } from '../../src/ui/App.js';
import { done, FakeSession, interrupted } from './fake-session.js';
import { frames } from './helpers.js';
import { renderTty, type TtyApp } from './tty.js';

const header = {
  agentName: 'support',
  host: 'example.test',
  user: 'u@example.com',
  version: '0.0.0',
};

const apps: TtyApp[] = [];
function start(
  session: ChatSession,
  opts: { rows?: number; resume?: string } = {},
) {
  const app = renderTty(
    <App core={session} header={header} resume={opts.resume} />,
    { rows: opts.rows ?? 40, columns: 80 },
  );
  apps.push(app);
  return app;
}
afterEach(() => {
  for (const app of apps.splice(0)) app.instance.unmount();
});

async function type(app: TtyApp, ...chunks: string[]) {
  for (const chunk of chunks) {
    app.stdin.write(chunk);
    await frames.settle();
  }
}

test('Enter twice sends the message once', async () => {
  let finish: (o: TurnOutcome) => void = () => {};
  const session = new FakeSession(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const app = start(session);
  await type(app, 'hello');
  app.stdin.write('\r');
  app.stdin.write('\r');
  await frames.settle();
  finish(done('hi'));
  await frames.until(() => expect(app.text()).toContain('hi'));
  expect(session.turns).toEqual([{ message: 'hello' }]);
});

test('pressing a twice answers the interrupt once', async () => {
  const session = new FakeSession(async (input) =>
    'message' in input ? interrupted : done('sent'),
  );
  const app = start(session);
  await type(app, 'pay', '\r');
  await frames.until(() => expect(app.text()).toContain('Approval needed'));
  app.stdin.write('a');
  app.stdin.write('a');
  await frames.until(() => expect(app.text()).toContain('sent'));
  expect(session.turns).toHaveLength(2);
  expect(session.turns[1]).toEqual({
    respond: [
      {
        interrupt: { name: 'approveTransfer', ref: 'r1', input: { amount: 5 } },
        output: { approved: true },
      },
    ],
  });
});

test('Ctrl+C during a turn aborts it and keeps the app open', async () => {
  const session = new FakeSession(
    (_input, { signal }) =>
      new Promise((resolve) =>
        signal?.addEventListener('abort', () =>
          resolve({ status: 'aborted', text: '', tools: [] }),
        ),
      ),
  );
  const app = start(session);
  let exited = false;
  void app.instance.waitUntilExit().then(() => {
    exited = true;
  });
  await type(app, 'slow', '\r');
  await type(app, '\x03');
  await frames.until(() => expect(app.text()).toContain('Stopped'));
  expect(session.signals[0]?.aborted).toBe(true);
  expect(exited).toBe(false);

  await type(app, '\x03');
  await frames.until(() => expect(exited).toBe(true));
});

test('a long streamed reply never redraws the whole screen', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const session = new FakeSession(async (_input, { onText }) => {
    let text = '';
    for (const line of lines) {
      text += `${line}\n`;
      onText?.(text);
      await frames.settle();
    }
    return done(text.trimEnd());
  });
  const app = start(session, { rows: 10 });
  await type(app, 'go', '\r');
  await frames.until(() => expect(app.text()).toContain('line 30'), 8000);
  await frames.settle();
  // Ink homes the cursor and erases the screen when a frame is taller than the terminal.
  expect(app.stdout.output).not.toContain('\x1b[1;1H');
  expect(app.stdout.output).not.toContain('\x1b[H');
  expect(app.text().split('line 17\n')).toHaveLength(2);
});

test('after a 409, Esc puts the message back in the prompt', async () => {
  const session = new FakeSession(async () => {
    throw new Error(
      'Server returned: 409: {"status":"ABORTED","message":"busy"}',
    );
  });
  const app = start(session);
  await type(app, 'resend me', '\r');
  await frames.until(() => expect(app.text()).toContain('Session busy'));
  await type(app, '\x1b');
  await frames.until(() =>
    expect(app.stdout.output.split('Session busy').at(-1)).toContain(
      'resend me',
    ),
  );
  await type(app, '\r');
  await frames.until(() => expect(session.turns).toHaveLength(2));
  expect(session.turns[1]).toEqual({ message: 'resend me' });
});

test('after a 409, r reloads the session and sends again', async () => {
  let calls = 0;
  const session = new FakeSession(async () => {
    calls++;
    if (calls === 1)
      throw new Error('Server returned: 409: {"status":"ABORTED"}');
    return done('second try');
  });
  const app = start(session);
  await type(app, 'again', '\r');
  await frames.until(() => expect(app.text()).toContain('Session busy'));
  await type(app, 'r');
  await frames.until(() => expect(app.text()).toContain('second try'));
  expect(session.reloads).toBe(1);
  expect(session.turns).toEqual([{ message: 'again' }, { message: 'again' }]);
});

test('Esc leaves an interrupt card for the prompt', async () => {
  const session = new FakeSession(async () => interrupted);
  const app = start(session);
  await type(app, 'pay', '\r');
  await frames.until(() => expect(app.text()).toContain('Approval needed'));
  await type(app, '\x1b');
  await frames.until(() => expect(app.text()).toContain('Approval left open'));
  await type(app, '/new', '\r');
  await frames.until(() => expect(app.text()).toContain('New session'));
});

test('Ctrl+C while a session loads stops the load', async () => {
  const session = new FakeSession(
    async () => done(''),
    () => new Promise(() => {}),
  );
  const app = start(session, { resume: 'old' });
  await frames.until(() => expect(app.text()).toContain('Loading session'));
  await type(app, '\x03');
  await frames.until(() => expect(app.text()).toContain('Stopped loading'));
  expect(session.sessionId).toBeUndefined();
});

test('streamed paragraphs keep their blank line', async () => {
  const session = new FakeSession(async (_input, { onText }) => {
    onText?.('first\n\nsecond');
    return done('first\n\nsecond');
  });
  const app = start(session);
  await type(app, 'go', '\r');
  await frames.until(() => expect(app.text()).toContain('second'));
  expect(app.text()).toMatch(/first\s*\n.*┃\s*\n.*second/);
});

test('/detach shows the running turn, then its reply', async () => {
  let finish: () => void = () => {};
  const session = new FakeSession(async () => done(''));
  session.detachScript = (snapshotId) =>
    new Promise((resolve) => {
      finish = () =>
        resolve({ snapshotId, status: 'completed', text: 'report ready' });
    });
  const app = start(session);
  await type(app, '/detach write a report', '\r');
  await frames.until(() =>
    expect(app.text()).toContain('Detached turn snap1 is running'),
  );
  finish();
  await frames.until(() => expect(app.text()).toContain('report ready'));
  expect(app.text()).toContain('Detached turn completed.');
  expect(session.detaches).toEqual(['write a report']);
  expect(session.turns).toEqual([]);
});

test('Ctrl+C stops waiting for a detached turn and says how to reattach', async () => {
  const session = new FakeSession(async () => done(''));
  session.detachScript = (_id, signal) =>
    new Promise((_, reject) =>
      signal?.addEventListener('abort', () => reject(signal.reason)),
    );
  const app = start(session);
  await type(app, '/detach long job', '\r');
  await frames.until(() =>
    expect(app.text()).toContain('Detached turn running'),
  );
  await type(app, '\x03');
  await frames.until(() => expect(app.text()).toContain('Stopped waiting'));
  expect(app.text()).toContain('/resume s1');
});

test('after a 409 on /detach, r reloads the session and detaches again', async () => {
  const session = new FakeSession(async () => done(''));
  session.detachError = new Error('Server returned: 409: {"status":"ABORTED"}');
  const app = start(session);
  await type(app, '/detach job', '\r');
  await frames.until(() => expect(app.text()).toContain('Session busy'));
  await type(app, 'r');
  await frames.until(() =>
    expect(app.text()).toContain('Detached turn completed.'),
  );
  expect(session.reloads).toBe(1);
  expect(session.detaches).toEqual(['job', 'job']);
});

test('resuming a session with a running detached turn waits for it', async () => {
  const session = new FakeSession(
    async () => done(''),
    async () => ({
      history: [{ role: 'user', text: 'earlier' }],
      pending: [],
      running: 'snap9',
    }),
  );
  const app = start(session, { resume: 'old' });
  await frames.until(() =>
    expect(app.text()).toContain('Detached turn completed.'),
  );
  expect(app.text()).toContain('Detached turn snap9 is still running');
  expect(app.text()).toContain('background done');
  expect(session.waits).toEqual(['snap9']);
});
