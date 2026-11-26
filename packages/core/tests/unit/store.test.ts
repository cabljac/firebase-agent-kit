import { createHash } from 'node:crypto';
import { GenkitError } from 'genkit';
import { expect, test } from 'vitest';
import { uidPrefix } from '../../src/store.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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

test('prefix is the sha256 of the JSON array [scope, uid], null without a scope', () => {
  expect(uidPrefix(ctx('alice'))).toBe(sha256('[null,"alice"]'));
  expect(uidPrefix(ctx('alice'), 'sales')).toBe(sha256('["sales","alice"]'));
});

test('prefix differs per scope for the same uid', () => {
  const prefixes = [undefined, 'sales', 'support'].map((scope) =>
    uidPrefix(ctx('alice'), scope),
  );
  expect(new Set(prefixes).size).toBe(3);
});
