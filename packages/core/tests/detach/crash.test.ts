import { describe, expect, test } from 'vitest';
import { client, event, lockDoc, runsOf, signUp, until } from './helpers.js';

describe('crash recovery', () => {
  test('after the worker process dies, the next turn settles the dead snapshot and resumes the session', async () => {
    const { uid, idToken } = await signUp();
    const chat = client(idToken).chat();
    await chat.send('echo start');
    const sessionId = chat.sessionId ?? '';
    const tag = `crash-${Date.now()}`;
    const task = await chat.detach(`crash 500 ${tag}`);
    await until('crash', async () => (await event(tag))?.crashedAt, 15_000);

    const expired = await until(
      'expired snapshot',
      async () => {
        const s = await client(idToken).getSnapshot({
          snapshotId: task.snapshotId,
        });
        return s?.status === 'expired' && s;
      },
      120_000,
      2_000,
    );
    expect(expired.parentId).toBeTruthy();
    await until(
      'lock lapse',
      async () => {
        const lock = (await lockDoc(uid, sessionId).get()).data();
        return !lock || lock.expiresAt < Date.now();
      },
      120_000,
      2_000,
    );

    // The stock client still names the dead row's snapshotId.
    expect(chat.snapshotId).toBe(task.snapshotId);
    const reply = await chat.send('echo after crash');
    expect(reply.text).toBe('after crash');

    const reaped = await client(idToken).getSnapshot({
      snapshotId: task.snapshotId,
    });
    expect(reaped?.status).toBe('aborted');
    expect(reaped).not.toHaveProperty('heartbeatAt');

    const bySession = await client(idToken).loadChat({ sessionId });
    expect((await bySession.send('count')).text).toBe('user messages: 3');
    expect((await runsOf(uid))[0]?.status).toBe('detached');
  }, 300_000);
});
