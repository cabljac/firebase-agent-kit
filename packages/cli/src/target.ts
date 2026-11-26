import { UsageError } from './auth.js';
import {
  DEFAULT_REGION,
  findProjectRoot,
  instanceRegion,
  kitAgentUrl,
  readProject,
} from './discover.js';
import type { SavedTarget } from './store.js';

/** The agent to talk to, and how its URL was found. */
export type Target = SavedTarget;

/** Options for {@link resolveTarget}. */
export interface ResolveTargetOptions {
  /** `--url` or `GENKIT_AGENT_URL`. */
  url?: string;
  /** The positional instance id. */
  instance?: string;
  project?: string;
  region?: string;
  cwd: string;
  /** The target of the last run. */
  last?: SavedTarget;
  /** Asks the user to choose one of several instance ids. */
  pickInstance?: (ids: string[]) => Promise<string>;
}

/**
 * Works out which agent to talk to. In order: an explicit URL; an instance
 * and project from the arguments or the Firebase project directory around
 * `cwd` (firebase.json and .firebaserc); then the last target.
 * @param opts See {@link ResolveTargetOptions}.
 */
export async function resolveTarget(
  opts: ResolveTargetOptions,
): Promise<Target> {
  if (opts.url) return { url: opts.url };
  const bare = !opts.instance && !opts.project && !opts.region;
  const root = await findProjectRoot(opts.cwd);

  if (!root) {
    if (opts.instance && opts.project) {
      const region = opts.region ?? DEFAULT_REGION;
      return build(opts.project, opts.instance, region);
    }
    if (bare && opts.last) return opts.last;
    throw new UsageError(
      opts.instance
        ? 'Pass --project with the instance id, or run in a Firebase project directory.'
        : 'Pass --url, or an instance id with --project, or run in a Firebase project directory.',
      'No agent to talk to',
    );
  }

  const project = await readProject(root, opts.project);
  const projectId = project.projectId;
  if (!projectId) {
    throw new UsageError(
      `${root} has no .firebaserc default project. Pass --project.`,
      'No Firebase project',
    );
  }
  const ids = project.instances.map((i) => i.id);
  if (
    bare &&
    opts.last?.project === projectId &&
    opts.last.instance &&
    ids.includes(opts.last.instance) &&
    ids.length > 1
  ) {
    return opts.last;
  }

  let instanceId = opts.instance;
  if (!instanceId) {
    if (ids.length === 0) {
      throw new UsageError(
        `${root}/firebase.json has no kit instances. Pass --url.`,
        'No kit instance',
      );
    }
    if (ids.length === 1) instanceId = ids[0];
    else if (opts.pickInstance) instanceId = await opts.pickInstance(ids);
    else {
      throw new UsageError(
        `This project has several kit instances: ${ids.join(', ')}. Name one.`,
        'Several kit instances',
      );
    }
  }
  if (!instanceId)
    throw new UsageError('No instance chosen.', 'No kit instance');

  const instance = project.instances.find((i) => i.id === instanceId);
  if (!instance && !opts.project) {
    throw new UsageError(
      `No kit instance "${instanceId}" in firebase.json. Known instances: ${ids.join(', ') || 'none'}.`,
      'Unknown instance',
    );
  }
  const region =
    opts.region ??
    (instance
      ? await instanceRegion(instance.configDir, projectId, project.alias)
      : DEFAULT_REGION);
  return build(projectId, instanceId, region);
}

function build(project: string, instance: string, region: string): Target {
  return {
    url: kitAgentUrl(region, project, instance),
    project,
    instance,
    region,
  };
}
