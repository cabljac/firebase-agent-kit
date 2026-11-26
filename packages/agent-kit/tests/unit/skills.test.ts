import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from 'firebase-functions';
import { type GenerateRequest, GenkitError, type MiddlewareRef } from 'genkit';
import { genkit } from 'genkit/beta';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  acceptMiddlewareNames,
  createPromptCheck,
  findPromptAgentProblems,
  kitMiddlewarePlugins,
  resolveSkillPaths,
  skillDescription,
} from '../../src/lib.js';

vi.mock('firebase-functions', () => ({ logger: { error: vi.fn() } }));

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(logger.error).mockClear();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const refundsSkill =
  '---\ndescription: How to handle refund requests.\n---\nCheck the order date first.\n';

/** Creates a function source directory that holds `files`. */
async function sourceDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-kit-source-'));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), content);
  }
  return dir;
}

function kit(dir: string, instanceId = 'support') {
  const ai = genkit({
    promptDir: join(dir, 'prompts'),
    plugins: kitMiddlewarePlugins(instanceId, () => dir),
  });
  const requests: GenerateRequest[] = [];
  ai.defineModel({ name: 'test/scripted' }, async (request) => {
    requests.push(request);
    const last = request.messages.at(-1);
    const toolResponse = last?.content.find(
      (p) => p.toolResponse,
    )?.toolResponse;
    if (toolResponse) {
      return {
        finishReason: 'stop',
        message: {
          role: 'model',
          content: [{ text: String(toolResponse.output) }],
        },
      };
    }
    const text = last?.content.map((p) => p.text ?? '').join('') ?? '';
    if (text.startsWith('use ')) {
      return {
        finishReason: 'stop',
        message: {
          role: 'model',
          content: [
            {
              toolRequest: {
                name: 'use_skill',
                ref: 'r1',
                input: { skillName: text.slice('use '.length) },
              },
            },
          ],
        },
      };
    }
    return {
      finishReason: 'stop',
      message: { role: 'model', content: [{ text: 'ok' }] },
    };
  });
  const definePrompt = (use: MiddlewareRef[], name = instanceId) =>
    ai.definePrompt({ name, model: 'test/scripted', use, messages: 'hello' });
  const systemText = (request: GenerateRequest | undefined) =>
    request?.messages
      .filter((m) => m.role === 'system')
      .flatMap((m) => m.content.map((p) => p.text ?? ''))
      .join('');
  return { ai, requests, definePrompt, systemText };
}

describe('instanceSkills', () => {
  test('reads skills from skills/<instance id> in the source directory by default', async () => {
    const dir = await sourceDir({
      'skills/support/refunds/SKILL.md': refundsSkill,
      'skills/sales/discounts/SKILL.md':
        '---\ndescription: Sales discounts.\n---\n',
    });
    const { ai, requests, systemText } = kit(dir);
    await ai.generate({
      model: 'test/scripted',
      system: 'You are the SUPPORT agent.',
      prompt: 'hi',
      use: [{ name: 'skills' }],
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(['use_skill']);
    const system = systemText(requests[0]);
    expect(system).toContain('<skills>');
    expect(system).toContain(' - refunds - How to handle refund requests.');
    expect(system).not.toContain('discounts');
  });

  test('use_skill returns the SKILL.md text', async () => {
    const dir = await sourceDir({
      'skills/support/refunds/SKILL.md': refundsSkill,
    });
    const { ai } = kit(dir);
    const res = await ai.generate({
      model: 'test/scripted',
      prompt: 'use refunds',
      use: [{ name: 'skills' }],
    });
    expect(res.text).toBe(refundsSkill);
  });

  test('rejects a skillPaths config outside the source directory', async () => {
    const dir = await sourceDir({
      'skills/support/refunds/SKILL.md': refundsSkill,
    });
    const { ai } = kit(dir);
    await expect(
      ai.generate({
        model: 'test/scripted',
        prompt: 'hi',
        use: [{ name: 'skills', config: { skillPaths: ['../elsewhere'] } }],
      }),
    ).rejects.toMatchObject({ status: 'FAILED_PRECONDITION' });
  });
});

describe('resolveSkillPaths', () => {
  test('defaults to skills/<instance id>', () => {
    expect(resolveSkillPaths('/src', 'support')).toEqual([
      '/src/skills/support',
    ]);
  });

  test('resolves skillPaths against the source directory', () => {
    expect(
      resolveSkillPaths('/src', 'support', ['shared/skills', '/src/more']),
    ).toEqual(['/src/shared/skills', '/src/more']);
  });

  test.each(['..', '../other', '/etc', '.', 'skills/../..'])(
    'rejects %j, which is not inside the source directory',
    (skillPath) => {
      expect(() => resolveSkillPaths('/src', 'support', [skillPath])).toThrow(
        `Skill path "${skillPath}" is not inside the function source directory.`,
      );
    },
  );

  test('accepts a directory whose name starts with two dots', () => {
    expect(resolveSkillPaths('/src', 'support', ['..skills'])).toEqual([
      '/src/..skills',
    ]);
  });
});

describe('acceptMiddlewareNames', () => {
  const prompt =
    '---\nmodel: test/scripted\nuse: [skills]\n---\n{{role "system"}}\nYou are the SUPPORT agent.\n';

  test('a bare name in the use: list of a .prompt file reaches generate', async () => {
    const dir = await sourceDir({
      'prompts/support.prompt': prompt,
      'skills/support/refunds/SKILL.md': refundsSkill,
    });
    const { ai, requests, systemText } = kit(dir);
    acceptMiddlewareNames(ai.registry);
    await ai.prompt('support')({});
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(['use_skill']);
    expect(systemText(requests[0])).toContain(' - refunds - ');
  });

  test('Genkit drops the bare name without it', async () => {
    const dir = await sourceDir({
      'prompts/support.prompt': prompt,
      'skills/support/refunds/SKILL.md': refundsSkill,
    });
    const { ai, requests } = kit(dir);
    await ai.prompt('support')({});
    expect(requests[0]?.tools ?? []).toEqual([]);
  });

  test('keeps { name, config } entries', async () => {
    const dir = await sourceDir({
      'prompts/support.prompt':
        '---\nmodel: test/scripted\nuse:\n  - name: skills\n    config: { skillPaths: [shared] }\n---\nhello\n',
      'shared/refunds/SKILL.md': refundsSkill,
    });
    const { ai, requests, systemText } = kit(dir);
    acceptMiddlewareNames(ai.registry);
    await ai.prompt('support')({});
    expect(systemText(requests[0])).toContain(' - refunds - ');
  });
});

describe('kitMiddlewarePlugins', () => {
  test('registers skills, retry and fallback, and not filesystem', async () => {
    const { ai } = kit(await sourceDir());
    for (const name of ['skills', 'retry', 'fallback']) {
      expect(await ai.registry.lookupValue('middleware', name)).toBeDefined();
    }
    expect(
      await ai.registry.lookupValue('middleware', 'filesystem'),
    ).toBeUndefined();
  });

  test('fallback in a .prompt file moves to the next model', async () => {
    const dir = await sourceDir({
      'prompts/support.prompt':
        '---\nmodel: test/down\nuse:\n  - name: fallback\n    config:\n      models: [{ name: test/up }]\n---\nhello\n',
    });
    const { ai } = kit(dir);
    acceptMiddlewareNames(ai.registry);
    ai.defineModel({ name: 'test/down' }, async () => {
      throw new GenkitError({ status: 'UNAVAILABLE', message: 'down' });
    });
    ai.defineModel({ name: 'test/up' }, async () => ({
      finishReason: 'stop',
      message: { role: 'model', content: [{ text: 'up' }] },
    }));
    expect((await ai.prompt('support')({})).text).toBe('up');
  });
});

describe('skillDescription', () => {
  test.each([
    ['---\ndescription: Refunds.\n---\nbody', 'Refunds.'],
    ['---\r\nname: x\r\ndescription:   Spaced  \r\n---\r\n', 'Spaced'],
  ])('reads the description of %j', (content, description) => {
    expect(skillDescription(content)).toBe(description);
  });

  test.each([
    ['no frontmatter', 'description: Refunds.\n'],
    ['no description line', '---\nname: refunds\n---\n'],
    ['an empty description', '---\ndescription:\nname: refunds\n---\n'],
    ['a blank description', '---\ndescription:   \n---\n'],
  ])('finds none with %s', (_label, content) => {
    expect(skillDescription(content)).toBeUndefined();
  });
});

describe('findPromptAgentProblems for middleware and skills', () => {
  const problemsOf = (
    overrides: Partial<{
      unknownMiddleware: string[];
      useProblems: string[];
      skillProblems: string[];
    }>,
  ) => ({
    missingPrompt: false,
    missingTools: [],
    unknownMiddleware: [],
    useProblems: [],
    skillProblems: [],
    ...overrides,
  });

  test('passes when the prompt uses skills and every skill is valid', async () => {
    const dir = await sourceDir({
      'skills/support/refunds/SKILL.md': refundsSkill,
      'skills/support/.hidden/notes.txt': 'ignored',
      'skills/support/README.md': 'ignored',
    });
    const { ai, definePrompt } = kit(dir);
    definePrompt([
      { name: 'skills' },
      { name: 'retry' },
      { name: 'fallback', config: { models: [{ name: 'test/scripted' }] } },
    ]);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toBeUndefined();
  });

  test('passes without skills/<instance id>/ when the prompt does not use skills', async () => {
    const dir = await sourceDir({
      'skills/sales/discounts/SKILL.md': refundsSkill,
    });
    const { ai, definePrompt } = kit(dir);
    definePrompt([]);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toBeUndefined();
  });

  test('reports use: skills without skills/<instance id>/', async () => {
    const dir = await sourceDir();
    const { ai, definePrompt } = kit(dir);
    definePrompt([{ name: 'skills' }]);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({
        skillProblems: [
          'prompts/support.prompt lists skills in use:, but skills/support/ does not exist',
        ],
      }),
    );
  });

  test('reports skills/<instance id>/ without use: skills', async () => {
    const dir = await sourceDir({
      'skills/support/refunds/SKILL.md': refundsSkill,
    });
    const { ai, definePrompt } = kit(dir);
    definePrompt([{ name: 'retry' }]);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({
        skillProblems: [
          'skills/support/ exists, but prompts/support.prompt does not list skills in use:',
        ],
      }),
    );
  });

  test('reports every middleware name that is not registered, including filesystem', async () => {
    const dir = await sourceDir();
    const { ai, definePrompt } = kit(dir);
    definePrompt([
      { name: 'retyr' },
      { name: 'retry' },
      { name: 'filesystem' },
    ]);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({ unknownMiddleware: ['retyr', 'filesystem'] }),
    );
  });

  test('reports a skill without SKILL.md or without a description', async () => {
    const dir = await sourceDir({
      'skills/support/refunds/SKILL.md': refundsSkill,
      'skills/support/returns/notes.md': 'no SKILL.md here',
      'skills/support/shipping/SKILL.md': '---\nname: shipping\n---\nbody',
      'skills/support/warranty/SKILL.md': '---\ndescription:\n---\nbody',
      'skills/support/exchanges/SKILL.md': 'description: no frontmatter',
    });
    const { ai, definePrompt } = kit(dir);
    definePrompt([{ name: 'skills' }]);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({
        skillProblems: [
          'skills/support/exchanges/SKILL.md has no description in its frontmatter',
          'skills/support/returns/SKILL.md does not exist',
          'skills/support/shipping/SKILL.md has no description in its frontmatter',
          'skills/support/warranty/SKILL.md has no description in its frontmatter',
        ],
      }),
    );
  });

  test('reports skillPaths outside the source directory and checks the others', async () => {
    const dir = await sourceDir({ 'shared/refunds/SKILL.md': refundsSkill });
    const { ai, definePrompt } = kit(dir);
    definePrompt([
      {
        name: 'skills',
        config: { skillPaths: ['../outside', '/etc', 'shared', 'gone'] },
      },
    ]);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({
        skillProblems: [
          'skillPaths entry "../outside" in prompts/support.prompt is not inside the function source directory',
          'skillPaths entry "/etc" in prompts/support.prompt is not inside the function source directory',
          'prompts/support.prompt lists skills in use:, but gone/ does not exist',
        ],
      }),
    );
  });

  test('reports a skills config that is not { skillPaths: string[] }', async () => {
    const dir = await sourceDir();
    const { ai, definePrompt } = kit(dir);
    definePrompt([{ name: 'skills', config: { skillPaths: 'skills' } }]);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({
        skillProblems: [
          'the skills config in prompts/support.prompt must be { skillPaths: [<directory>, ...] }',
        ],
      }),
    );
  });

  test('reports an empty skills folder and an empty skillPaths list', async () => {
    const dir = await sourceDir({ 'skills/support/notes.md': 'not a skill' });
    const { ai, definePrompt } = kit(dir);
    definePrompt([{ name: 'skills' }]);
    definePrompt([{ name: 'skills', config: { skillPaths: [] } }], 'sales');
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({ skillProblems: ['skills/support/ has no skills'] }),
    );
    await expect(
      findPromptAgentProblems(ai.registry, 'sales', dir),
    ).resolves.toEqual(
      problemsOf({
        skillProblems: ['the skillPaths list in prompts/sales.prompt is empty'],
      }),
    );
  });

  test('reports a quoted or multi-line description', async () => {
    const dir = await sourceDir({
      'skills/support/refunds/SKILL.md': refundsSkill,
      'skills/support/double/SKILL.md': '---\ndescription: "Quoted."\n---\n',
      'skills/support/single/SKILL.md': "---\ndescription: 'Quoted.'\n---\n",
      'skills/support/folded/SKILL.md':
        '---\ndescription: >-\n  Folded text.\n---\n',
      'skills/support/literal/SKILL.md': '---\ndescription: |\n  Text.\n---\n',
    });
    const { ai, definePrompt } = kit(dir);
    definePrompt([{ name: 'skills' }]);
    const problem = (name: string) =>
      `skills/support/${name}/SKILL.md has a quoted or multi-line description: write it plain, unquoted, on one line`;
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({
        skillProblems: ['double', 'folded', 'literal', 'single'].map(problem),
      }),
    );
  });

  test('reports each malformed use: entry and still checks the others', async () => {
    const dir = await sourceDir({
      'prompts/support.prompt':
        '---\nmodel: test/scripted\nuse: [skills, 42, { config: {} }, { name: 7 }, retyr]\n---\nhello\n',
    });
    const { ai } = kit(dir);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({
        unknownMiddleware: ['retyr'],
        useProblems: [
          'entry 42 is not a middleware name or { name, config }',
          'entry {"config":{}} is not a middleware name or { name, config }',
          'entry {"name":7} is not a middleware name or { name, config }',
        ],
        skillProblems: [
          'prompts/support.prompt lists skills in use:, but skills/support/ does not exist',
        ],
      }),
    );
  });

  test.each([
    ['a bare fallback', [{ name: 'fallback' }]],
    ['an empty models list', [{ name: 'fallback', config: { models: [] } }]],
  ])('reports fallback with %s', async (_label, use) => {
    const dir = await sourceDir();
    const { ai, definePrompt } = kit(dir);
    definePrompt(use);
    await expect(
      findPromptAgentProblems(ai.registry, 'support', dir),
    ).resolves.toEqual(
      problemsOf({
        useProblems: ['fallback needs config.models with at least one model'],
      }),
    );
  });

  test('the prompt check puts every problem in the emulator error message', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
    const dir = await sourceDir({
      'skills/support/refunds/SKILL.md': '---\n---\n',
    });
    const { ai, definePrompt } = kit(dir);
    definePrompt([
      { name: 'skills' },
      { name: 'filesystem' },
      { name: 'fallback' },
    ]);
    const check = createPromptCheck({
      registry: ai.registry,
      instanceId: 'support',
      knownTools: () => [],
      sourceDir: dir,
    });
    await expect(check()).rejects.toMatchObject({
      status: 'FAILED_PRECONDITION',
      originalMessage:
        'Agent kit instance "support" uses middleware that is not available: filesystem. Fix the use: list in prompts/support.prompt. The kit provides skills, retry, fallback. Agent kit instance "support" has use: problems: fallback needs config.models with at least one model. Fix the use: list in prompts/support.prompt. Agent kit instance "support" has skill problems: skills/support/refunds/SKILL.md has no description in its frontmatter.',
    });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), {
      instanceId: 'support',
      missingPrompt: false,
      missingTools: [],
      unknownMiddleware: ['filesystem'],
      useProblems: ['fallback needs config.models with at least one model'],
      skillProblems: [
        'skills/support/refunds/SKILL.md has no description in its frontmatter',
      ],
      knownTools: [],
    });
  });
});
