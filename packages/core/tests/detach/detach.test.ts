import { describe, expect, test } from 'vitest';
import {
  client,
  event,
  lockDoc,
  postDetach,
  runsOf,
  signUp,
  until,
} from './helpers.js';

async function startedChat(idToken: string, name?: string) {
  const chat = client(idToken, name).chat();
  await chat.send('echo start');
  return chat;
}

describe('detached turns with the stock client', () => {
  test('a detached turn runs in the worker, holds the session lock, and continues the chat', async () => {
    const { uid, idToken } = await signUp();
    const chat = await startedChat(idToken);
    const sessionId = chat.sessionId ?? '';
    const tag = `flow-${Date.now()}`;

    const task = await chat.detach(`slow 10000 ${tag}`);
    expect(task.snapshotId).toBeTruthy();
    expect(chat.sessionId).toBe(sessionId);

    const lock = (await lockDoc(uid, sessionId).get()).data();
    const [run] = await runsOf(uid);
    expect(lock?.owner).toBe(run?.id);
    expect(run).toMatchObject({ status: 'detached', instanceId: null });
    expect(run).not.toHaveProperty('input');
    expect(run).not.toHaveProperty('init');
    expect(run).not.toHaveProperty('claims');
    expect(run?.expireAt).toBeDefined();

    const other = await client(idToken).loadChat({ sessionId });
    await expect(other.send('echo concurrent')).rejects.toThrow(/409/);

    const pending = await client(idToken).getSnapshot({
      snapshotId: task.snapshotId,
    });
    expect(pending?.status).toBe('pending');

    const final = await task.wait();
    expect(final.status).toBe('completed');
    expect(JSON.stringify(final.state?.messages?.at(-1))).toContain(
      'slept 10000',
    );
    expect((await event(tag))?.functionTarget).toBe('detachWorker');

    const next = await client(idToken).loadChat({ sessionId });
    expect((await next.send('count')).text).toBe('user messages: 3');
    await until(
      'run settled',
      async () => (await runsOf(uid))[0]?.status === 'done',
      5_000,
    );
    expect((await runsOf(uid))[0]?.final).toEqual({
      status: 'completed',
      finishReason: 'stop',
    });
  });

  test('a new session can start with a detached turn', async () => {
    const { idToken } = await signUp();
    const chat = client(idToken).chat();
    const task = await chat.detach('echo first');
    expect(chat.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await task.wait()).status).toBe('completed');
    const resumed = await client(idToken).loadChat({
      sessionId: chat.sessionId ?? '',
    });
    expect((await resumed.send('count')).text).toBe('user messages: 2');
  });

  test('the next turn right after a detached turn settles is not refused (lock retry)', async () => {
    const { idToken } = await signUp();
    const chat = await startedChat(idToken);
    for (let i = 0; i < 3; i++) {
      const task = await chat.detach(`echo detached ${i}`);
      expect((await task.wait()).status).toBe('completed');
      const reply = await chat.send(`echo attached ${i}`);
      expect(reply.text).toBe(`attached ${i}`);
    }
  });

  test('abort from the client stops the turn in the worker and releases the lock', async () => {
    const { uid, idToken } = await signUp();
    const chat = await startedChat(idToken);
    const tag = `abort-${Date.now()}`;
    const task = await chat.detach(`slow 30000 ${tag}`);
    await until(
      'model start',
      async () => (await event(tag))?.startedAt,
      10_000,
    );
    await task.abort();
    const final = await task.wait();
    expect(final.status).toBe('aborted');
    expect((await event(tag))?.abortedAt).toBeDefined();
    await until(
      'lock release',
      async () => !(await lockDoc(uid, chat.sessionId ?? '').get()).exists,
      5_000,
    );
    const resumed = await client(idToken).loadChat({
      sessionId: chat.sessionId ?? '',
    });
    expect((await resumed.send('echo after abort')).text).toBe('after abort');
  });

  test('a worker near its deadline aborts the turn and the snapshot settles aborted', async () => {
    const { uid, idToken } = await signUp();
    const chat = await startedChat(idToken, 'shortAgent');
    const task = await chat.detach('slow 60000');
    const final = await task.wait();
    expect(final.status).toBe('aborted');
    await until(
      'lock release',
      async () => !(await lockDoc(uid, chat.sessionId ?? '').get()).exists,
      5_000,
    );
    expect((await runsOf(uid))[0]).toMatchObject({
      status: 'aborted',
      error: { status: 'ABORTED' },
    });
  });
});

describe('the detached response', () => {
  test('is one SSE frame for Accept: text/event-stream', async () => {
    const { idToken } = await signUp();
    const chat = await startedChat(idToken);
    const res = await postDetach(idToken, 'echo raw', {
      init: { snapshotId: chat.snapshotId },
      accept: 'text/event-stream',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(
      /^data: \{"result":\{.*"finishReason":"detached".*\}\}\n\n$/,
    );
    const { result } = JSON.parse(body.slice('data: '.length));
    expect(result.sessionId).toBe(chat.sessionId);
    await client(idToken).waitForSnapshot(result.snapshotId);
  });

  test('is a JSON result otherwise', async () => {
    const { idToken } = await signUp();
    const chat = await startedChat(idToken);
    const res = await postDetach(idToken, 'echo raw', {
      init: { snapshotId: chat.snapshotId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result).toMatchObject({
      sessionId: chat.sessionId,
      finishReason: 'detached',
    });
    await client(idToken).waitForSnapshot(String(body.result.snapshotId));
  });
});

describe('detach rejections', () => {
  test('an agent with detached turns off answers 400 FAILED_PRECONDITION', async () => {
    const { uid, idToken } = await signUp();
    const res = await postDetach(idToken, 'echo x', { name: 'offAgent' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'FAILED_PRECONDITION' });
    expect(await runsOf(uid)).toHaveLength(0);
  });

  test('a turn over the Firestore document limit answers 400 INVALID_ARGUMENT', async () => {
    const { uid, idToken } = await signUp();
    const res = await postDetach(idToken, `echo ${'x'.repeat(1_100_000)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'INVALID_ARGUMENT' });
    expect(await runsOf(uid)).toHaveLength(0);
  });
});
