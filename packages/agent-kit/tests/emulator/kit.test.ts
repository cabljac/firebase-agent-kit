import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { remoteAgent } from 'genkit/beta/client';
import { describe, expect, test } from 'vitest';
import { defined, signUp } from '../../../core/tests/emulator/helpers.js';

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

const problems: Record<string, string> = {
  typo: 'Agent kit instance "typo" lists tools that are not defined: lookupOrdr. Fix the tools: list in prompts/typo.prompt or define the tools with ai.defineTool.',
  missing:
    'Agent kit instance "missing" has no prompt: add prompts/missing.prompt to the function source directory.',
  badskill:
    'Agent kit instance "badskill" has skill problems: skills/badskill/returns/SKILL.md has no description in its frontmatter.',
};

const misconfigured = (instanceId: string) => ({
  status: 400,
  body: { status: 'FAILED_PRECONDITION', message: problems[instanceId] },
});

const preflight = (instanceId: string, origin: string) =>
  fetch(instanceUrl(instanceId), {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });

interface EmulatedTrigger {
  name: string;
  timeoutSeconds: number;
  availableMemoryMb: number;
}

async function emulatedTrigger(instanceId: string): Promise<EmulatedTrigger> {
  const res = await fetch('http://127.0.0.1:5001/backends');
  const { backends } = (await res.json()) as {
    backends: Array<{ functionTriggers: EmulatedTrigger[] }>;
  };
  return defined(
    backends
      .flatMap((b) => b.functionTriggers)
      .find((t) => t.name === `kit-${instanceId}-agent`),
    `trigger for ${instanceId}`,
  );
}

describe('firebase-agent-kit instances', () => {
  test.each([
    [
      'support',
      'You are the SUPPORT agent.',
      'approveRefund,lookupOrder,userTool',
    ],
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

  test('a turn pauses on a kit interrupt and resumes with the client response', async () => {
    const { idToken } = await signUp();
    const chat = client('support', idToken).chat();
    const paused = await chat.send('call approveRefund');
    expect(paused.finishReason).toBe('interrupted');
    const approval = defined(
      paused.interrupts.find((i) => i.name === 'approveRefund'),
      'approveRefund interrupt',
    );
    const resumed = await chat.resume({
      respond: [approval.respond({ approved: true })],
    });
    expect(resumed.text).toBe(
      `tool result: ${JSON.stringify({ approved: true })}`,
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
    ['badskill', 'a skill without a description'],
  ])(
    '%s (%s) answers 400 FAILED_PRECONDITION with the problem on every request',
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

describe('firebase-agent-kit params from config-<instance>/.env.<projectId>', () => {
  test('a non-empty JSON CORS_ORIGINS turns CORS on', async () => {
    const res = await preflight('support', 'https://app.example.com');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );
    expect(res.headers.get('access-control-allow-headers')).toContain(
      'authorization',
    );
  });

  test.each([
    ['sales', '[]'],
    ['typo', 'an empty value'],
  ])(
    '%s (CORS_ORIGINS set to %s) sends no CORS headers',
    async (instanceId) => {
      const res = await preflight(instanceId, 'https://app.example.com');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    },
  );

  test.each([
    ['support', 60, 256],
    ['sales', 120, 512],
  ])(
    '%s gets its TIMEOUT_SECONDS and MEMORY',
    async (instanceId, timeoutSeconds, availableMemoryMb) => {
      expect(await emulatedTrigger(instanceId)).toMatchObject({
        timeoutSeconds,
        availableMemoryMb,
      });
    },
  );

  test('the turn lock lease follows TIMEOUT_SECONDS', async () => {
    const { uid, idToken } = await signUp();
    const chat = client('sales', idToken).chat();
    await chat.send('prompt');
    const sessionId = defined(chat.sessionId, 'sessionId');
    const lockId = createHash('sha256')
      .update(`${uid}:${sessionId}`)
      .digest('hex');
    const db = getFirestore(initializeApp({ projectId: 'demo-test' }, 'kit'));
    const lockRef = db.collection('genkit-agent-locks').doc(lockId);

    const sentAt = Date.now();
    const turn = chat.send('wait 3000');
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    turn.then(markSettled, markSettled);
    let expiresAt: unknown;
    while (expiresAt === undefined && !settled) {
      expiresAt = (await lockRef.get()).get('expiresAt');
    }
    const readAt = Date.now();
    await turn;
    expect(typeof expiresAt).toBe('number');
    // The lock was taken between sentAt and readAt.
    expect(Number(expiresAt) - readAt).toBeLessThanOrEqual(150_000);
    expect(Number(expiresAt) - sentAt).toBeGreaterThanOrEqual(150_000);
  });

  test('an ENFORCE_APP_CHECK value other than exactly true or false runs no turn', async () => {
    const { idToken } = await signUp();
    expect(await postTurn('loose', 'prompt', idToken)).toEqual({
      status: 400,
      body: {
        status: 'FAILED_PRECONDITION',
        message:
          'Agent kit instance "loose" has an invalid value for ENFORCE_APP_CHECK: "TRUE". Set it to exactly true or false in config-loose/.env.<projectId>.',
      },
    });
  });

  test.each(['getSnapshot', 'waitForSnapshot', 'abort'])(
    'an invalid ENFORCE_APP_CHECK value also rejects /%s',
    async (route) => {
      const { idToken } = await signUp();
      const res = await fetch(`${instanceUrl('loose')}/${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ data: { snapshotId: 'x' } }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ status: 'FAILED_PRECONDITION' });
    },
  );

  test('ENFORCE_APP_CHECK rejects a signed-in caller without an App Check token', async () => {
    const { idToken } = await signUp();
    expect(await postTurn('guarded', 'prompt', idToken)).toEqual({
      status: 403,
      body: {
        status: 'PERMISSION_DENIED',
        message: 'AppCheck token is required',
      },
    });
  });
});

describe('firebase-agent-kit middleware from the prompt use: list', () => {
  test('use: [skills] gives the model the use_skill tool', async () => {
    const { idToken } = await signUp();
    const chat = client('skilled', idToken).chat();
    expect((await chat.send('tools')).text).toBe('use_skill');
  });

  test('use: [skills] lists the skills of skills/<instance id>/ in the system prompt', async () => {
    const { idToken } = await signUp();
    const system = (await client('skilled', idToken).chat().send('prompt'))
      .text;
    expect(system.startsWith('You are the SKILLED agent.')).toBe(true);
    expect(system).toContain('<skills>');
    expect(system).toContain(' - refunds - How to handle a refund request.');
  });

  test('use_skill returns the text of the SKILL.md file', async () => {
    const { idToken } = await signUp();
    const skill = await readFile(
      join(import.meta.dirname, 'app/skills/skilled/refunds/SKILL.md'),
      'utf8',
    );
    const res = await client('skilled', idToken)
      .chat()
      .send('call use_skill {"skillName":"refunds"}');
    expect(res.text).toBe(`tool result: ${JSON.stringify(skill)}`);
  });

  test('an instance whose prompt does not use skills gets no use_skill tool or skills block', async () => {
    const { idToken } = await signUp();
    const chat = client('sales', idToken).chat();
    expect((await chat.send('tools')).text).toBe('quotePrice');
    expect((await chat.send('prompt')).text).toBe('You are the SALES agent.');
  });

  test('use: retry retries a failed model call', async () => {
    const { idToken } = await signUp();
    const key = randomUUID();
    const res = await client('retried', idToken).chat().send(`flaky ${key}`);
    expect(res.text).toBe(`flaky ${key} recovered`);
  });

  test('without retry the same model failure fails the turn', async () => {
    const { idToken } = await signUp();
    const key = randomUUID();
    await expect(
      client('sales', idToken).chat().send(`flaky ${key}`),
    ).rejects.toThrow(`flaky ${key} failed`);
  });
});
