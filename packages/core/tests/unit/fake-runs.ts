import type { AgentOutput } from 'genkit/beta';
import type {
  AbandonOutcome,
  ClaimedRun,
  ClaimRefusal,
  NewRun,
  OutputRecord,
  RunDoc,
  RunError,
  RunStore,
} from '../../src/runs.js';

/** A stored run: the document fields the tests look at. */
export type StoredRun = RunDoc &
  Partial<NewRun> & {
    final?: { status: string | null; finishReason: string | null };
  };

/** An in-memory {@link RunStore} with the same state rules as Firestore's. */
export class MemoryRunStore implements RunStore {
  readonly docs = new Map<string, StoredRun>();
  private readonly listeners = new Map<
    string,
    Set<(run: RunDoc | undefined) => void>
  >();

  private put(runId: string, run: StoredRun) {
    this.docs.set(runId, run);
    for (const l of this.listeners.get(runId) ?? []) l({ ...run });
  }

  /** Applies `patch` to a run and notifies watchers. */
  update(runId: string, patch: Partial<StoredRun>) {
    const run = this.docs.get(runId);
    if (run) this.put(runId, { ...run, ...patch });
  }

  async create(runId: string, run: NewRun): Promise<void> {
    if (this.docs.has(runId)) throw new Error('exists');
    this.put(runId, { ...run, status: 'queued' });
  }

  watch(runId: string, onChange: (run: RunDoc | undefined) => void) {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(onChange);
    this.listeners.set(runId, set);
    queueMicrotask(() => {
      if (set.has(onChange)) {
        const run = this.docs.get(runId);
        onChange(run ? { ...run } : undefined);
      }
    });
    return () => set.delete(onChange);
  }

  async cancelIfQueued(runId: string, error: RunError): Promise<boolean> {
    const run = this.docs.get(runId);
    if (run?.status !== 'queued') return false;
    const { input: _i, init: _n, claims: _c, ...rest } = run;
    this.put(runId, { ...rest, status: 'cancelled', error });
    return true;
  }

  async abandonIfNoOutput(runId: string): Promise<AbandonOutcome> {
    const run = this.docs.get(runId);
    if (run?.status === 'running' && !run.output) {
      this.put(runId, { ...run, status: 'abandoned' });
      return { abandoned: true };
    }
    return { abandoned: false, run };
  }

  async claim(
    runId: string,
    instanceId: string | null,
  ): Promise<ClaimedRun | ClaimRefusal> {
    const run = this.docs.get(runId);
    if (!run) return 'missing';
    if (run.status !== 'queued') return 'not-queued';
    if (run.instanceId !== instanceId) return 'wrong-instance';
    const { input, init, claims, ...rest } = run;
    this.put(runId, { ...rest, status: 'running' });
    if (!input || !claims) throw new Error('incomplete run');
    return {
      runId,
      uid: run.uid,
      instanceId: run.instanceId,
      lockKey: run.lockKey,
      input,
      init: init ?? null,
      claims,
    };
  }

  async recordOutput(
    runId: string,
    output: AgentOutput,
  ): Promise<OutputRecord> {
    const run = this.docs.get(runId);
    if (!run) throw new Error('missing');
    if (run.status === 'abandoned') return 'abandoned';
    this.put(runId, {
      ...run,
      output,
      status: output.finishReason === 'detached' ? 'detached' : 'done',
    });
    return 'recorded';
  }

  async finish(
    runId: string,
    status: 'done' | 'failed' | 'cancelled',
    details: {
      error?: RunError;
      final?: { status: string | null; finishReason: string | null };
    },
  ): Promise<void> {
    const run = this.docs.get(runId);
    if (!run) throw new Error('missing');
    this.put(runId, { ...run, status, ...details });
  }
}
