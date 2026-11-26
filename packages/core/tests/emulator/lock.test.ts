import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { FirestoreTurnLock } from '../../src/lock.js';

const COLLECTION = 'lock-test';
let db: FirebaseFirestore.Firestore;

beforeAll(() => {
  initializeApp({ projectId: 'demo-test' });
  db = getFirestore();
});

afterEach(async () => {
  const docs = await db.collection(COLLECTION).listDocuments();
  await Promise.all(docs.map((d) => d.delete()));
});

const makeLock = () => new FirestoreTurnLock({ collection: COLLECTION });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('second acquire returns null while held', async () => {
  const lock = makeLock();
  const lease = await lock.acquire('s1', { leaseMs: 60_000 });
  expect(lease).not.toBeNull();
  expect(await lock.acquire('s1', { leaseMs: 60_000 })).toBeNull();
});

test('different keys do not conflict', async () => {
  const lock = makeLock();
  expect(await lock.acquire('a', { leaseMs: 60_000 })).not.toBeNull();
  expect(await lock.acquire('b', { leaseMs: 60_000 })).not.toBeNull();
});

test('acquire succeeds after release, and release is idempotent', async () => {
  const lock = makeLock();
  const lease = await lock.acquire('s1', { leaseMs: 60_000 });
  await lease?.release();
  await lease?.release();
  expect(await lock.acquire('s1', { leaseMs: 60_000 })).not.toBeNull();
});

test('expired lease is taken over', async () => {
  const lock = makeLock();
  expect(await lock.acquire('s1', { leaseMs: 3_000 })).not.toBeNull();
  expect(await lock.acquire('s1', { leaseMs: 3_000 })).toBeNull();
  await sleep(3_100);
  expect(await lock.acquire('s1', { leaseMs: 3_000 })).not.toBeNull();
});

test('stale holder release does not delete the new holder lock', async () => {
  const lock = makeLock();
  const stale = await lock.acquire('s1', { leaseMs: 50 });
  await sleep(100);
  const fresh = await lock.acquire('s1', { leaseMs: 60_000 });
  expect(fresh).not.toBeNull();
  expect(fresh?.owner).not.toBe(stale?.owner);
  await stale?.release();
  expect(await lock.acquire('s1', { leaseMs: 100 })).toBeNull();
});

test('concurrent acquires yield exactly one lease', async () => {
  const lock = makeLock();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => lock.acquire('s1', { leaseMs: 60_000 })),
  );
  expect(results.filter((r) => r !== null)).toHaveLength(1);
});

test('acquire takes the caller-supplied owner', async () => {
  const lock = makeLock();
  const lease = await lock.acquire('s1', { leaseMs: 60_000, owner: 'run-1' });
  expect(lease?.owner).toBe('run-1');
});

test('renew extends the lease only for the owner', async () => {
  const lock = makeLock();
  await lock.acquire('s1', { leaseMs: 1_000, owner: 'run-1' });
  expect(await lock.renew('s1', 'other', 60_000)).toBe(false);
  expect(await lock.renew('s1', 'run-1', 60_000)).toBe(true);
  await sleep(1_100);
  expect(await lock.acquire('s1', { leaseMs: 1_000 })).toBeNull();
});

test('renew fails after another holder took over an expired lease', async () => {
  const lock = makeLock();
  await lock.acquire('s1', { leaseMs: 50, owner: 'run-1' });
  await sleep(100);
  expect(await lock.acquire('s1', { leaseMs: 60_000 })).not.toBeNull();
  expect(await lock.renew('s1', 'run-1', 60_000)).toBe(false);
});

test('renew of a released lock fails', async () => {
  const lock = makeLock();
  await lock.acquire('s1', { leaseMs: 60_000, owner: 'run-1' });
  await lock.release('s1', 'run-1');
  expect(await lock.renew('s1', 'run-1', 60_000)).toBe(false);
});

test('release by key and owner leaves another owner alone', async () => {
  const lock = makeLock();
  await lock.acquire('s1', { leaseMs: 60_000, owner: 'run-1' });
  await lock.release('s1', 'run-2');
  expect(await lock.acquire('s1', { leaseMs: 60_000 })).toBeNull();
  await lock.release('s1', 'run-1');
  expect(await lock.acquire('s1', { leaseMs: 60_000 })).not.toBeNull();
});
