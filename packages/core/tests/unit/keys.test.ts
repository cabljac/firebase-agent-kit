import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { lockKey, userKey } from '../../src/keys.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('userKey', () => {
  test.each([
    ['a colon moved between scope and uid', ['a:b', 'c'], ['a', 'b:c']],
    ['a scope named null and no scope', ['null', 'u'], [undefined, 'u']],
    ['an empty scope and no scope', ['', 'u'], [undefined, 'u']],
    ['a uid that spells a scoped pair', [undefined, '["s","u"]'], ['s', 'u']],
    ['a quote moved between scope and uid', ['a"', 'b'], ['a', '"b']],
    ['a comma moved between scope and uid', ['a","b', 'c'], ['a', 'b","c']],
  ] as const)(
    'keys do not collide for %s',
    (_name, [scopeA, uidA], [scopeB, uidB]) => {
      expect(userKey(uidA, scopeA)).not.toBe(userKey(uidB, scopeB));
    },
  );
});

describe('lockKey', () => {
  test('is the unscoped key of the uid, a colon, then the sessionId', () => {
    expect(lockKey('u1', 's1')).toBe(`${sha256('[null,"u1"]')}:s1`);
  });

  test('does not collide when a colon moves between uid and sessionId', () => {
    expect(lockKey('a:b', 'c')).not.toBe(lockKey('a', 'b:c'));
  });
});
