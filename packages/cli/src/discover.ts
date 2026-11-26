import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { UsageError } from './auth.js';

/** The region Cloud Functions uses when a kit instance names none. */
export const DEFAULT_REGION = 'us-central1';

/** A kit instance from the `instances` map of a firebase.json kit config. */
export interface KitInstance {
  id: string;
  /** Absolute path of the instance's config directory. */
  configDir: string;
}

/** What a Firebase project directory says about its agents. */
export interface FirebaseProject {
  root: string;
  /** The project id, from `--project` or `.firebaserc`. */
  projectId?: string;
  /** The `.firebaserc` alias that named the project, if one did. */
  alias?: string;
  instances: KitInstance[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new UsageError(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      'Cannot read Firebase project',
    );
  }
}

/**
 * Finds the nearest directory at or above `start` that has a firebase.json.
 * @param start Directory to start from.
 */
export async function findProjectRoot(
  start: string,
): Promise<string | undefined> {
  let dir = resolve(start);
  for (;;) {
    if (await exists(join(dir, 'firebase.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Reads the project id and the kit instances of a Firebase project directory.
 * `project` may be a project id or a `.firebaserc` alias; without it, the
 * `default` alias is used.
 * @param root Directory with firebase.json.
 * @param project The `--project` value, if any.
 */
export async function readProject(
  root: string,
  project?: string,
): Promise<FirebaseProject> {
  const config = await readJson(join(root, 'firebase.json'));
  const rcPath = join(root, '.firebaserc');
  const rc = (await exists(rcPath)) ? await readJson(rcPath) : {};
  const aliases: Record<string, unknown> =
    isRecord(rc) && isRecord(rc.projects) ? rc.projects : {};
  const name = project ?? 'default';
  const fromAlias = aliases[name];
  const projectId =
    typeof fromAlias === 'string' ? fromAlias : (project ?? undefined);
  const alias = typeof fromAlias === 'string' ? name : undefined;

  const functions = isRecord(config) ? config.functions : undefined;
  const entries = Array.isArray(functions) ? functions : [functions];
  const instances: KitInstance[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.kit !== 'string') continue;
    if (!isRecord(entry.instances)) continue;
    for (const [id, dir] of Object.entries(entry.instances)) {
      if (typeof dir === 'string')
        instances.push({ id, configDir: resolve(root, dir) });
    }
  }
  return { root, projectId, alias, instances };
}

/**
 * Parses the lines of a dotenv file. It supports `KEY=value`, quoted values,
 * `export` prefixes and comments, which covers what firebase-tools writes.
 * @param text File contents.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match?.[1]) continue;
    let value = match[2] ?? '';
    const quoted = /^(['"])(.*?)\1\s*(?:#.*)?$/.exec(value);
    if (quoted) value = quoted[2] ?? '';
    else value = value.replace(/\s+#.*$/, '');
    out[match[1]] = value;
  }
  return out;
}

/**
 * Returns the region of a kit instance: `FUNCTION_DEFAULT_REGION` from its
 * `.env`, then `.env.<projectId>`, then `.env.<alias>` (later files win, as
 * in firebase-tools), or {@link DEFAULT_REGION}.
 * @param configDir The instance's config directory.
 * @param projectId The project id.
 * @param alias The `.firebaserc` alias, if one named the project.
 */
export async function instanceRegion(
  configDir: string,
  projectId: string,
  alias?: string,
): Promise<string> {
  let region: string | undefined;
  const files = [
    '.env',
    `.env.${projectId}`,
    ...(alias ? [`.env.${alias}`] : []),
  ];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(configDir, file), 'utf8');
    } catch {
      continue;
    }
    region = parseDotenv(text).FUNCTION_DEFAULT_REGION || region;
  }
  return region ?? DEFAULT_REGION;
}

/**
 * Builds the HTTPS URL of a kit instance's agent function.
 * @param region Cloud Functions region.
 * @param projectId Firebase project id.
 * @param instanceId Kit instance id.
 */
export function kitAgentUrl(
  region: string,
  projectId: string,
  instanceId: string,
): string {
  return `https://${region}-${projectId}.cloudfunctions.net/kit-${instanceId}-agent`;
}
