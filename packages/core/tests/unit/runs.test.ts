import type { DecodedIdToken } from 'firebase-admin/auth';
import { GenkitError } from 'genkit';
import { describe, expect, test } from 'vitest';
import {
  assertRunFits,
  MAX_DOCUMENT_BYTES,
  type NewRun,
  refreshClaims,
  userCheckFailure,
} from '../../src/runs.js';

const claims: DecodedIdToken = {
  uid: 'u1',
  sub: 'u1',
  aud: 'demo',
  iss: 'https://securetoken.google.com/demo',
  iat: 1_000,
  exp: 4_600,
  auth_time: 1_000,
  email: 'a@example.com',
  firebase: { identities: {}, sign_in_provider: 'password' },
  plan: 'pro',
  role: 'admin',
};

const run = (text: string): NewRun => ({
  uid: 'u1',
  instanceId: null,
  lockKey: 'k',
  input: { message: { role: 'user', content: [{ text }] } },
  init: null,
  claims,
});

describe('assertRunFits', () => {
  test('accepts a normal run', () => {
    expect(() => assertRunFits(run('hello'))).not.toThrow();
  });

  test('rejects a run over the Firestore document limit with INVALID_ARGUMENT', () => {
    try {
      assertRunFits(run('x'.repeat(MAX_DOCUMENT_BYTES)));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GenkitError);
      expect((err as GenkitError).status).toBe('INVALID_ARGUMENT');
      expect((err as GenkitError).code).toBe(400);
    }
  });

  test('counts UTF-8 bytes, not characters', () => {
    expect(() => assertRunFits(run('é'.repeat(600_000)))).toThrow(/too large/);
  });
});

describe('refreshClaims', () => {
  test('replaces custom claims and keeps the standard ones', () => {
    const fresh = refreshClaims(claims, { plan: 'free' });
    expect(fresh).toMatchObject({ uid: 'u1', auth_time: 1_000, plan: 'free' });
    expect(fresh).not.toHaveProperty('role');
  });

  test('drops every custom claim when the user has none', () => {
    expect(refreshClaims(claims, undefined)).not.toHaveProperty('plan');
  });

  test('a custom claim cannot override a standard claim', () => {
    expect(refreshClaims(claims, { uid: 'evil' }).uid).toBe('u1');
  });
});

describe('userCheckFailure', () => {
  const active = { disabled: false, tokensValidAfterTime: undefined };

  test('passes an active user', () => {
    expect(userCheckFailure(active, claims)).toBeUndefined();
  });

  test('refuses a deleted user', () => {
    expect(userCheckFailure(undefined, claims)?.status).toBe('UNAUTHENTICATED');
  });

  test('refuses a disabled user', () => {
    expect(
      userCheckFailure({ ...active, disabled: true }, claims)?.status,
    ).toBe('PERMISSION_DENIED');
  });

  test('refuses tokens revoked after auth_time', () => {
    const revoked = {
      ...active,
      tokensValidAfterTime: new Date(2_000_000).toUTCString(),
    };
    expect(userCheckFailure(revoked, claims)?.status).toBe('UNAUTHENTICATED');
  });

  test('passes tokens issued after the revocation', () => {
    const revokedBefore = {
      ...active,
      tokensValidAfterTime: new Date(500_000).toUTCString(),
    };
    expect(userCheckFailure(revokedBefore, claims)).toBeUndefined();
  });
});
