import { parseArgs } from 'node:util';
import { UsageError } from './auth.js';

/** Parsed command line options. */
export interface CliOptions {
  /** The positional kit instance id. */
  instance?: string;
  url?: string;
  project?: string;
  region?: string;
  apiKey?: string;
  email?: string;
  idToken?: string;
  /** `''` resumes the last session; any other value names a session. */
  resume?: string;
  logout: boolean;
  help: boolean;
  version: boolean;
}

/** Text for `--help`. */
export const USAGE = `Usage: genkit-agent-chat [instance] [options]

Chat with a Genkit agent served by onAgentRequest or the agent kit.

In a Firebase project directory, the agent URL is built from firebase.json,
.firebaserc and the instance's .env files. Without arguments, it reconnects
to the last agent.

Options:
  --project <id>       Firebase project id or .firebaserc alias
  --region <region>    Cloud Functions region of the instance
  --url <url>          Agent function URL (env GENKIT_AGENT_URL)
  --api-key <key>      Firebase web API key (env FIREBASE_API_KEY)
  --email <email>      Sign in with this email; the password is asked once
  --id-token <token>   Use this Firebase ID token; prefer env FIREBASE_ID_TOKEN
  --resume [id]        Resume a session (default: the last one)
  --logout             Forget the saved sign-in for the API key and email
  -h, --help           Show this help
  -v, --version        Show the version

In the chat, type /help for commands.`;

/**
 * Parses the command line. Options win over environment variables, and an
 * explicit --email wins over FIREBASE_ID_TOKEN; only --id-token beats it.
 * @param argv Arguments after the program name.
 * @param env Environment to read defaults from.
 */
export function parseCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const args = argv.map((arg, i) => {
    const next = argv[i + 1];
    return arg === '--resume' && (next === undefined || next.startsWith('-'))
      ? '--resume='
      : arg;
  });
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (err) {
    throw new UsageError(
      err instanceof Error ? err.message : String(err),
      'Unknown option',
    );
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) {
    throw new UsageError(
      `Expected at most one instance id, got: ${positionals.join(' ')}`,
      'Unknown argument',
    );
  }
  const envToken = values.email
    ? undefined
    : env.FIREBASE_ID_TOKEN || undefined;
  return {
    instance: positionals[0],
    url: values.url ?? (env.GENKIT_AGENT_URL || undefined),
    project: values.project,
    region: values.region,
    apiKey: values['api-key'] ?? (env.FIREBASE_API_KEY || undefined),
    email: values.email,
    idToken: values['id-token'] ?? envToken,
    resume: values.resume,
    logout: values.logout ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

function parse(args: string[]) {
  return parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      project: { type: 'string' },
      region: { type: 'string' },
      'api-key': { type: 'string' },
      email: { type: 'string' },
      'id-token': { type: 'string' },
      resume: { type: 'string' },
      logout: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}
