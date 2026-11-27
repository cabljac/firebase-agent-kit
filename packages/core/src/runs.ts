import type { DecodedIdToken, UserRecord } from 'firebase-admin/auth';
import {
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { GenkitError, type StatusName } from 'genkit';
import type { AgentInit, AgentInput, AgentOutput } from 'genkit/beta';

/** The lifecycle status of a detached run. */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'detached'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'aborted'
  | 'abandoned';

/** An error recorded on a run. */
export interface RunError {
  status: StatusName;
  message: string;
}

/** The fields the turn route writes when it creates a run. */
export interface NewRun {
  uid: string;
  instanceId: string | null;
  lockKey: string;
  input: AgentInput;
  init: AgentInit | null;
  claims: DecodedIdToken;
}

/** A run document as read back. */
export interface RunDoc {
  status: RunStatus;
  uid: string;
  instanceId: string | null;
  lockKey: string;
  output?: AgentOutput;
  error?: RunError;
}

/** What a successful claim hands the worker; the run doc no longer holds it. */
export interface ClaimedRun extends NewRun {
  runId: string;
}

/** Why a claim was refused. */
export type ClaimRefusal = 'missing' | 'not-queued' | 'wrong-instance';

/**
 * A run that waited in the queue longer than its turn route can have waited.
 * The claim cancels it; the worker releases its lock.
 */
export interface StaleRun {
  stale: true;
  lockKey: string;
}

/** A terminal run status the worker writes. */
export type FinishStatus = 'done' | 'failed' | 'cancelled' | 'aborted';

/** Outcome of recording a worker's output. */
export type OutputRecord = 'recorded' | 'abandoned';

/** Outcome of the turn route giving up on the output wait. */
export type AbandonOutcome =
  | { abandoned: true }
  | { abandoned: false; run: RunDoc | undefined };

/** Storage for detached runs. Every state move is atomic. */
export interface RunStore {
  /** Writes a new `queued` run. */
  create(runId: string, run: NewRun, now: number): Promise<void>;
  /** Calls `onChange` with each version of the run until unsubscribed. */
  watch(
    runId: string,
    onChange: (run: RunDoc | undefined) => void,
    onError: (err: unknown) => void,
  ): () => void;
  /** Moves `queued` to `cancelled`. Resolves `false` when it was not queued. */
  cancelIfQueued(runId: string, error: RunError): Promise<boolean>;
  /**
   * Moves `running` without output to `abandoned`. Otherwise returns the run
   * as it stands.
   */
  abandonIfNoOutput(runId: string): Promise<AbandonOutcome>;
  /**
   * Moves `queued` to `running` and removes `input`, `init` and `claims` from
   * the document in the same transaction. A run created more than
   * `staleAfterMs` before `now` is cancelled instead.
   */
  claim(
    runId: string,
    instanceId: string | null,
    now: number,
    staleAfterMs: number,
  ): Promise<ClaimedRun | ClaimRefusal | StaleRun>;
  /** Records an output. A run the turn route abandoned is not overwritten. */
  recordOutput(runId: string, output: AgentOutput): Promise<OutputRecord>;
  /** Writes a terminal status with optional details. */
  finish(
    runId: string,
    status: FinishStatus,
    details: {
      error?: RunError;
      final?: { status: string | null; finishReason: string | null };
    },
    now: number,
  ): Promise<void>;
}

/** Firestore's maximum document size. */
export const MAX_DOCUMENT_BYTES = 1_048_576;
/** Room kept for field names, Firestore types and the fields added later. */
const DOCUMENT_HEADROOM_BYTES = 16_384;
/** How long a run document lives before the TTL policy may delete it. */
export const RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rejects a run whose document would not fit in Firestore, with
 * `INVALID_ARGUMENT`. The estimate is the UTF-8 length of the JSON form plus
 * headroom.
 */
export function assertRunFits(run: NewRun): void {
  const bytes = Buffer.byteLength(JSON.stringify(run), 'utf8');
  const limit = MAX_DOCUMENT_BYTES - DOCUMENT_HEADROOM_BYTES;
  if (bytes > limit) {
    throw new GenkitError({
      status: 'INVALID_ARGUMENT',
      message: `The detached turn is too large: ${bytes} bytes, the limit is ${limit}.`,
    });
  }
}

const STANDARD_CLAIMS = new Set([
  'aud',
  'auth_time',
  'email',
  'email_verified',
  'exp',
  'firebase',
  'iat',
  'iss',
  'name',
  'phone_number',
  'picture',
  'sub',
  'uid',
  'user_id',
]);

/**
 * Returns the claims with the custom claims replaced by `customClaims`, the
 * current custom claims of the user. Standard ID token claims are kept,
 * including `iat` and `exp` of the original token, which can be in the past.
 */
export function refreshClaims(
  claims: DecodedIdToken,
  customClaims: Record<string, unknown> | undefined,
): DecodedIdToken {
  const custom = Object.fromEntries(
    Object.entries(customClaims ?? {}).filter(
      ([key]) => !STANDARD_CLAIMS.has(key),
    ),
  );
  const standard = Object.fromEntries(
    Object.entries(claims).filter(([key]) => STANDARD_CLAIMS.has(key)),
  );
  return {
    ...custom,
    ...standard,
    aud: claims.aud,
    auth_time: claims.auth_time,
    exp: claims.exp,
    firebase: claims.firebase,
    iat: claims.iat,
    iss: claims.iss,
    sub: claims.sub,
    uid: claims.uid,
  };
}

/**
 * Checks the user at claim time. Returns the reason to refuse the run, or
 * `undefined` when it may run: the user is gone, disabled, or revoked their
 * tokens after the ID token's `auth_time`, the same rule as
 * `verifyIdToken(token, true)`.
 */
export function userCheckFailure(
  user: Pick<UserRecord, 'disabled' | 'tokensValidAfterTime'> | undefined,
  claims: Pick<DecodedIdToken, 'auth_time'>,
): RunError | undefined {
  if (!user) {
    return { status: 'UNAUTHENTICATED', message: 'The user no longer exists.' };
  }
  if (user.disabled) {
    return { status: 'PERMISSION_DENIED', message: 'The user is disabled.' };
  }
  const validAfter = user.tokensValidAfterTime
    ? Date.parse(user.tokensValidAfterTime)
    : Number.NaN;
  if (!Number.isNaN(validAfter) && claims.auth_time * 1000 < validAfter) {
    return {
      status: 'UNAUTHENTICATED',
      message: 'The ID token was revoked after the turn was sent.',
    };
  }
  return undefined;
}

/** The error of a run cancelled because it waited too long in the queue. */
export const STALE_ERROR: RunError = {
  status: 'DEADLINE_EXCEEDED',
  message: 'The run waited in the queue longer than its turn route waits.',
};

function readRun(data: FirebaseFirestore.DocumentData): RunDoc {
  return {
    status: data.status,
    uid: data.uid,
    instanceId: data.instanceId ?? null,
    lockKey: data.lockKey,
    ...(data.output && { output: data.output }),
    ...(data.error && { error: data.error }),
  };
}

/** A {@link RunStore} with one Firestore document per run. */
export class FirestoreRunStore implements RunStore {
  constructor(
    private readonly db: () => Firestore,
    private readonly collection: string,
  ) {}

  private ref(runId: string) {
    return this.db().collection(this.collection).doc(runId);
  }

  async create(runId: string, run: NewRun, now: number): Promise<void> {
    // Firestore rejects undefined values, which JSON drops.
    await this.ref(runId).create({
      ...JSON.parse(JSON.stringify(run)),
      status: 'queued',
      createdAt: now,
      expireAt: Timestamp.fromMillis(now + RUN_TTL_MS),
    });
  }

  watch(
    runId: string,
    onChange: (run: RunDoc | undefined) => void,
    onError: (err: unknown) => void,
  ): () => void {
    return this.ref(runId).onSnapshot((snap) => {
      const data = snap.data();
      onChange(data ? readRun(data) : undefined);
    }, onError);
  }

  async cancelIfQueued(runId: string, error: RunError): Promise<boolean> {
    const ref = this.ref(runId);
    return this.db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.get('status') !== 'queued') return false;
      tx.update(ref, {
        status: 'cancelled',
        error,
        input: FieldValue.delete(),
        init: FieldValue.delete(),
        claims: FieldValue.delete(),
      });
      return true;
    });
  }

  async abandonIfNoOutput(runId: string): Promise<AbandonOutcome> {
    const ref = this.ref(runId);
    return this.db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data?.status === 'running' && !data.output) {
        tx.update(ref, { status: 'abandoned' });
        return { abandoned: true };
      }
      return { abandoned: false, run: data ? readRun(data) : undefined };
    });
  }

  async claim(
    runId: string,
    instanceId: string | null,
    now: number,
    staleAfterMs: number,
  ): Promise<ClaimedRun | ClaimRefusal | StaleRun> {
    const ref = this.ref(runId);
    return this.db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return 'missing';
      if (data.status !== 'queued') return 'not-queued';
      if ((data.instanceId ?? null) !== instanceId) return 'wrong-instance';
      if (
        typeof data.createdAt === 'number' &&
        now - data.createdAt > staleAfterMs
      ) {
        tx.update(ref, {
          status: 'cancelled',
          settledAt: now,
          error: STALE_ERROR,
          input: FieldValue.delete(),
          init: FieldValue.delete(),
          claims: FieldValue.delete(),
        });
        return { stale: true, lockKey: data.lockKey };
      }
      tx.update(ref, {
        status: 'running',
        claimedAt: now,
        input: FieldValue.delete(),
        init: FieldValue.delete(),
        claims: FieldValue.delete(),
      });
      return {
        runId,
        uid: data.uid,
        instanceId: data.instanceId ?? null,
        lockKey: data.lockKey,
        input: data.input,
        init: data.init ?? null,
        claims: data.claims,
      };
    });
  }

  async recordOutput(
    runId: string,
    output: AgentOutput,
  ): Promise<OutputRecord> {
    const ref = this.ref(runId);
    return this.db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.get('status') === 'abandoned') return 'abandoned';
      tx.update(ref, {
        status: output.finishReason === 'detached' ? 'detached' : 'done',
        output: JSON.parse(JSON.stringify(output)),
      });
      return 'recorded';
    });
  }

  async finish(
    runId: string,
    status: FinishStatus,
    details: {
      error?: RunError;
      final?: { status: string | null; finishReason: string | null };
    },
    now: number,
  ): Promise<void> {
    await this.ref(runId).update({
      status,
      settledAt: now,
      ...(details.error && { error: details.error }),
      ...(details.final && { final: details.final }),
    });
  }
}
