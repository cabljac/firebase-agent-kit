import type { DetachedTurnsConfig } from './types.js';

let read: <S>(handle: DetachedTurns<S>) => DetachedTurnsConfig<S>;
let create: <S>(config: DetachedTurnsConfig<S>) => DetachedTurns<S>;

/**
 * An opaque detached turn config from {@link defineDetachedTurns}. Pass the
 * same object to {@link onAgentRequest} (its `detach` option) and to
 * {@link onAgentTask}.
 */
export class DetachedTurns<S = unknown> {
  readonly #config: DetachedTurnsConfig<S>;

  private constructor(config: DetachedTurnsConfig<S>) {
    this.#config = config;
  }

  static {
    read = (handle) => handle.#config;
    create = (config) => new DetachedTurns(config);
  }
}

/** Wraps a resolved config in its opaque handle. */
export function detachedTurnsHandle<S>(
  config: DetachedTurnsConfig<S>,
): DetachedTurns<S> {
  return create(config);
}

/** Reads the resolved config behind a handle. */
export function detachedTurnsConfig<S>(
  handle: DetachedTurns<S>,
): DetachedTurnsConfig<S> {
  return read(handle);
}
