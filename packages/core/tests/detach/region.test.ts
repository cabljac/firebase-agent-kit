import { describe, expect, test } from 'vitest';
import { client, event, postDetach, runsOf, signUp } from './helpers.js';

const REGION = 'europe-west1';

describe('detached turns in a region set by a param in setGlobalOptions', () => {
  test('the turn route queues the run on the worker in its own region', async () => {
    const { uid, idToken } = await signUp();
    const res = await postDetach(idToken, 'echo regional', {
      name: 'regionalAgent',
      region: REGION,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      result: { finishReason: 'detached' },
    });
    const [run] = await runsOf(uid);
    expect(run?.status).not.toBe('cancelled');
  });

  test('the stock client runs a detached turn in the worker of that region', async () => {
    const { idToken } = await signUp();
    const chat = client(idToken, 'regionalAgent', REGION).chat();
    const tag = `region-${Date.now()}`;
    const task = await chat.detach(`slow 1000 ${tag}`);
    expect((await task.wait()).status).toBe('completed');
    expect((await event(tag))?.functionTarget).toBe('regionalWorker');
  });
});
