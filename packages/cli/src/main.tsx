import type { Readable, Writable } from 'node:stream';
import { render } from 'ink';
import {
  ManagementApiError,
  NoGoogleCredentialsError,
  projectApiKey,
} from './apikey.js';
import { parseCliArgs, USAGE } from './args.js';
import { authScope, StaticTokenSource, signIn, UsageError } from './auth.js';
import { ChatCore } from './chat.js';
import { explain } from './errors.js';
import { describeUrl } from './format.js';
import { problemLines, runPlain } from './plain.js';
import { ConfigStore } from './store.js';
import { resolveTarget, type Target } from './target.js';
import { App } from './ui/App.js';
import {
  CancelledError,
  pickOne,
  printProblem,
  promptApiKey,
  promptPassword,
} from './ui/prompt.js';
import { VERSION } from './version.js';

/** What {@link main} reads from and writes to; tests replace parts of it. */
export interface MainDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** True when both stdin and stdout are terminals. */
  tty: boolean;
  store: ConfigStore;
  promptPassword: (email: string) => Promise<string>;
  promptApiKey: (project: string) => Promise<string>;
  pickOne: (
    title: string,
    options: { label: string; hint?: string }[],
  ) => Promise<number>;
  fetch?: typeof fetch;
}

function defaultDeps(): MainDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    store: new ConfigStore(),
    promptPassword,
    promptApiKey,
    pickOne,
  };
}

/**
 * Runs the CLI and returns the exit code: 0 on success, 1 on a failure,
 * 130 when the user cancels a prompt.
 * @param argv Arguments after the program name.
 * @param overrides Replacements for the process streams and prompts.
 */
export async function main(
  argv: string[],
  overrides: Partial<MainDeps> = {},
): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const { env, store, tty } = deps;
  const out = (text: string) => deps.stdout.write(`${text}\n`);
  let staticToken = false;

  try {
    const opts = parseCliArgs(argv, env);
    if (opts.help) {
      out(USAGE);
      return 0;
    }
    if (opts.version) {
      out(VERSION);
      return 0;
    }

    const pick = async <T,>(
      title: string,
      items: T[],
      label: (item: T) => { label: string; hint?: string },
    ): Promise<T> => {
      const index = await deps.pickOne(title, items.map(label));
      const item = items[index];
      if (item === undefined) throw new CancelledError();
      return item;
    };
    const target = (interactive: boolean) =>
      store.getLastTarget().then((last) =>
        resolveTarget({
          url: opts.url,
          instance: opts.instance,
          project: opts.project,
          region: opts.region,
          cwd: deps.cwd,
          last,
          pickInstance:
            interactive && tty
              ? (ids) =>
                  pick('Choose a kit instance', ids, (id) => ({ label: id }))
              : undefined,
        }),
      );

    if (opts.logout) {
      let apiKey = opts.apiKey;
      if (!apiKey) {
        const project = await target(false).then(
          (t) => t.project,
          () => undefined,
        );
        if (project) apiKey = await store.getApiKey(project);
      }
      if (!apiKey)
        throw new UsageError('Pass --api-key (or set FIREBASE_API_KEY).');
      const email = await store.deleteCredential(
        authScope(apiKey, env),
        opts.email,
      );
      out(email ? `Signed out ${email}.` : 'No saved sign-in to remove.');
      return 0;
    }

    const resolved: Target = await target(true);
    const findApiKey = async (project: string): Promise<string> => {
      const cached = await store.getApiKey(project);
      if (cached) return cached;
      let apiKey: string;
      try {
        apiKey = await projectApiKey({
          project,
          fetch: deps.fetch,
          env,
          pickApp: tty
            ? (apps) =>
                pick('Choose a web app', apps, (a) => ({
                  label: a.displayName,
                  hint: a.appId,
                }))
            : undefined,
        });
      } catch (err) {
        if (
          !(err instanceof NoGoogleCredentialsError) &&
          !(err instanceof ManagementApiError)
        )
          throw err;
        if (!tty) {
          throw new UsageError(
            `Could not look up the web API key of ${project}: ${err.message} Pass --api-key.`,
            'No API key',
          );
        }
        apiKey = await deps.promptApiKey(project);
      }
      await store.setApiKey(project, apiKey);
      return apiKey;
    };
    const apiKey =
      opts.apiKey ??
      (opts.idToken || !resolved.project
        ? undefined
        : await findApiKey(resolved.project));

    const tokens = await signIn({
      apiKey,
      email: opts.email,
      idToken: opts.idToken,
      store,
      env,
      fetch: deps.fetch,
      promptPassword: tty
        ? deps.promptPassword
        : () => {
            throw new UsageError(
              'Sign in once in a terminal to save a refresh token, or set FIREBASE_ID_TOKEN.',
              'No saved sign-in',
            );
          },
    });
    staticToken = tokens instanceof StaticTokenSource;
    await store.setLastTarget(resolved);

    const user = tokens.user.email ?? tokens.user.uid;
    let resume = opts.resume;
    if (resume === '') {
      resume = await store.getLastSession(resolved.url, tokens.user.uid);
      if (!resume)
        deps.stderr.write('No previous session. Starting a new one.\n');
    }
    const core = new ChatCore({ url: resolved.url, tokens, store });
    const url = describeUrl(resolved.url);
    const explainError = (err: unknown) => explain(err, { staticToken });

    if (!tty) {
      return await runPlain({
        core,
        agentName: url.name,
        user,
        input: deps.stdin,
        output: deps.stdout,
        errors: deps.stderr,
        resume,
        explainError,
      });
    }
    const app = render(
      <App
        core={core}
        header={{
          agentName: url.name,
          host: url.host,
          user,
          version: VERSION,
          project: resolved.project
            ? `${resolved.project} (${resolved.region})`
            : undefined,
          authEmulator: env.FIREBASE_AUTH_EMULATOR_HOST,
        }}
        resume={resume}
        explainError={explainError}
      />,
      { exitOnCtrlC: false },
    );
    await app.waitUntilExit();
    return 0;
  } catch (err) {
    if (err instanceof CancelledError) return 130;
    const problem = explain(err, { staticToken });
    if (tty) await printProblem(problem);
    else
      for (const line of problemLines(problem)) deps.stderr.write(`${line}\n`);
    return 1;
  }
}
