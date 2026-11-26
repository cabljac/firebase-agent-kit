import { createHash } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { remoteAgent } from 'genkit/beta/client';
import { lockKey, userKey } from '../../src/keys.js';

/** The demo project of the detach suite. */
export const PROJECT = 'demo-detach';
/** Base URL of the functions in the emulator. */
export const BASE = `http://127.0.0.1:5101/${PROJECT}/us-central1`;
const SIGN_UP =
  'http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake';

/** The Admin SDK app on the suite's emulators. */
export function admin() {
  if (getApps().length === 0) initializeApp({ projectId: PROJECT });
  return { db: getFirestore(), auth: getAuth() };
}

let counter = 0;

/** Creates a user in the Auth emulator and returns its uid and ID token. */
export async function signUp(): Promise<{ uid: string; idToken: string }> {
  const res = await fetch(SIGN_UP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `d-${Date.now()}-${counter++}@example.com`,
      password: 'pw-123456',
      returnSecureToken: true,
    }),
  });
  if (!res.ok) throw new Error(`signUp failed: ${res.status}`);
  const json = (await res.json()) as { localId: string; idToken: string };
  return { uid: json.localId, idToken: json.idToken };
}

/** The stock client for the function `name`. */
export function client(idToken: string, name = 'detachAgent') {
  return remoteAgent({
    url: `${BASE}/${name}`,
    headers: { Authorization: `Bearer ${idToken}` },
  });
}

/** Sends a raw detached turn. */
export function postDetach(
  idToken: string,
  text: string,
  opts: {
    name?: string;
    init?: Record<string, unknown>;
    accept?: string;
    signal?: AbortSignal;
  } = {},
) {
  return fetch(`${BASE}/${opts.name ?? 'detachAgent'}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
      ...(opts.accept ? { Accept: opts.accept } : {}),
    },
    body: JSON.stringify({
      data: { message: { role: 'user', content: [{ text }] }, detach: true },
      ...(opts.init ? { init: opts.init } : {}),
    }),
    signal: opts.signal,
  });
}

/** The lock document of a session. */
export function lockDoc(uid: string, sessionId: string) {
  return admin()
    .db.collection('agent-kit-locks')
    .doc(createHash('sha256').update(lockKey(uid, sessionId)).digest('hex'));
}

/** The runs of a user. */
export async function runsOf(
  uid: string,
): Promise<Array<FirebaseFirestore.DocumentData & { id: string }>> {
  const snap = await admin()
    .db.collection('agent-kit-runs')
    .where('uid', '==', uid)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** How many snapshots a user has. */
export async function snapshotCount(uid: string): Promise<number> {
  const snap = await admin()
    .db.collection('agent-kit-sessions')
    .doc(userKey(uid))
    .collection('snapshots')
    .count()
    .get();
  return snap.data().count;
}

/** Polls `fn` until it returns a truthy value. */
export async function until<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  everyMs = 250,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A test event the scripted model wrote. */
export async function event(tag: string) {
  return (
    await admin().db.collection('detach-test-events').doc(tag).get()
  ).data();
}
