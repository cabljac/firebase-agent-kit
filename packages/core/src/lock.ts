import { createHash, randomUUID } from 'node:crypto';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import type { FirestoreTurnLockOptions, TurnLease, TurnLock } from './types.js';

const DEFAULT_COLLECTION = 'genkit-agent-locks';

/** A {@link TurnLock} backed by one Firestore document per key. */
export class FirestoreTurnLock implements TurnLock {
  private readonly collection: string;
  private readonly explicitDb: Firestore | undefined;

  constructor(opts?: FirestoreTurnLockOptions) {
    this.collection = opts?.collection ?? DEFAULT_COLLECTION;
    this.explicitDb = opts?.firestore;
  }

  private db(): Firestore {
    return this.explicitDb ?? getFirestore();
  }

  private ref(key: string) {
    const id = createHash('sha256').update(key).digest('hex');
    return this.db().collection(this.collection).doc(id);
  }

  async acquire(
    key: string,
    opts: { leaseMs: number; owner?: string },
  ): Promise<TurnLease | null> {
    const ref = this.ref(key);
    const owner = opts.owner ?? randomUUID();
    const acquired = await this.db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const expiresAt: unknown = snap.get('expiresAt');
      if (snap.exists && typeof expiresAt === 'number' && expiresAt > now) {
        return false;
      }
      tx.set(ref, { owner, expiresAt: now + opts.leaseMs });
      return true;
    });
    if (!acquired) return null;

    let released = false;
    return {
      key,
      owner,
      release: async () => {
        if (released) return;
        released = true;
        await this.release(key, owner);
      },
    };
  }

  async renew(key: string, owner: string, leaseMs: number): Promise<boolean> {
    const ref = this.ref(key);
    return this.db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get('owner') !== owner) return false;
      tx.update(ref, { expiresAt: Date.now() + leaseMs });
      return true;
    });
  }

  async release(key: string, owner: string): Promise<void> {
    const ref = this.ref(key);
    try {
      await this.db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.get('owner') === owner) tx.delete(ref);
      });
    } catch (err) {
      logger.error(`Failed to release turn lock for "${key}"`, err);
    }
  }
}
