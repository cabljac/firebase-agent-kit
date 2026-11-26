import { GenkitError } from 'genkit';
import { expect, test } from 'vitest';
import { uidPrefix } from '../../src/store.js';

const ctx = (uid?: string) => ({
  context: uid === undefined ? {} : { auth: { uid } },
});

test('throws UNAUTHENTICATED without a uid', () => {
  for (const options of [undefined, {}, ctx(), ctx('')]) {
    let error: unknown;
    try {
      uidPrefix(options);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GenkitError);
    expect((error as GenkitError).status).toBe('UNAUTHENTICATED');
  }
});

test('prefix is a sha256 hex, safe for hostile uids', () => {
  for (const uid of ['alice', '../other', 'a/b']) {
    expect(uidPrefix(ctx(uid))).toMatch(/^[0-9a-f]{64}$/);
  }
});

test('prefix differs per uid', () => {
  expect(uidPrefix(ctx('alice'))).not.toBe(uidPrefix(ctx('bob')));
});

test('same uid gives same prefix', () => {
  expect(uidPrefix(ctx('alice'))).toBe(uidPrefix(ctx('alice')));
});
