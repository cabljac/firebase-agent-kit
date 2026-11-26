import { remoteAgent } from 'genkit/beta/client';
import { describe, expect, test } from 'vitest';
import { signUp } from '../../../../tests/emulator/helpers.js';

const instanceUrl = (instanceId: string) =>
  `http://127.0.0.1:5001/demo-test/us-central1/kit-${instanceId}-agent`;

const client = (instanceId: string, idToken: string) =>
  remoteAgent({
    url: instanceUrl(instanceId),
    headers: { Authorization: `Bearer ${idToken}` },
  });

async function postTurn(instanceId: string, text: string, idToken: string) {
  const res = await fetch(instanceUrl(instanceId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      data: { message: { role: 'user', content: [{ text }] } },
    }),
  });
  return { status: res.status, body: await res.json() };
}

const misconfigured = (instanceId: string) => ({
  status: 400,
  body: {
    status: 'FAILED_PRECONDITION',
    message: `Agent kit instance "${instanceId}" is misconfigured. See the function logs.`,
  },
});

describe('genkit-agent-kit instances', () => {
  test.each([
    ['support', 'You are the SUPPORT agent.', 'lookupOrder,userTool'],
    ['sales', 'You are the SALES agent.', 'quotePrice'],
  ])(
    '%s runs its own prompt and tool list',
    async (instanceId, system, tools) => {
      const { idToken } = await signUp();
      const chat = client(instanceId, idToken).chat();
      expect((await chat.send('prompt')).text).toBe(system);
      expect((await chat.send('tools')).text).toBe(tools);
    },
  );

  test('a tool defined in the wrapper after the kit import sees the caller uid', async () => {
    const { uid, idToken } = await signUp();
    const chat = client('support', idToken).chat();
    const res = await chat.send('call userTool');
    expect(res.text).toBe(
      `tool result: ${JSON.stringify({ tool: 'userTool', uid })}`,
    );
  });

  test('an instance cannot call a tool its prompt does not list', async () => {
    const { idToken } = await signUp();
    const turn = client('sales', idToken).chat().send('call userTool');
    await expect(turn).rejects.toMatchObject({
      name: 'AgentError',
      status: 'NOT_FOUND',
    });
    await expect(turn).rejects.toThrow('Tool userTool not found');
  });

  test.each([
    ['typo', 'a misspelled tool name'],
    ['missing', 'no prompt file'],
  ])(
    '%s (%s) answers 400 FAILED_PRECONDITION on every request',
    async (instanceId) => {
      const { idToken } = await signUp();
      expect(await postTurn(instanceId, 'prompt', idToken)).toEqual(
        misconfigured(instanceId),
      );
      expect(await postTurn(instanceId, 'prompt', idToken)).toEqual(
        misconfigured(instanceId),
      );
      await expect(
        client(instanceId, idToken).chat().send('prompt'),
      ).rejects.toThrow(
        `Server returned: 400: ${JSON.stringify(misconfigured(instanceId).body)}`,
      );
    },
  );

  test('a misconfigured instance still answers 401 to a caller without a token', async () => {
    const res = await fetch(instanceUrl('typo'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: { message: { role: 'user', content: [{ text: 'prompt' }] } },
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ status: 'UNAUTHENTICATED' });
  });
});
