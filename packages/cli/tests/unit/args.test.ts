import { expect, test } from 'vitest';
import { parseCliArgs } from '../../src/args.js';
import { UsageError } from '../../src/auth.js';

test('reads options, then the environment', () => {
  expect(
    parseCliArgs(['--url', 'https://a', '--email', 'e@x'], {
      GENKIT_AGENT_URL: 'https://env',
      FIREBASE_API_KEY: 'k',
    }),
  ).toMatchObject({ url: 'https://a', apiKey: 'k', email: 'e@x' });
  expect(parseCliArgs([], { GENKIT_AGENT_URL: 'https://env' }).url).toBe(
    'https://env',
  );
  expect(parseCliArgs([], { FIREBASE_ID_TOKEN: 't' }).idToken).toBe('t');
});

test('an explicit --email wins over FIREBASE_ID_TOKEN, but not over --id-token', () => {
  expect(
    parseCliArgs(['--email', 'e@x'], { FIREBASE_ID_TOKEN: 't' }).idToken,
  ).toBeUndefined();
  expect(
    parseCliArgs(['--email', 'e@x', '--id-token', 'flag'], {}).idToken,
  ).toBe('flag');
});

test('takes an instance id and --project and --region anywhere', () => {
  expect(
    parseCliArgs(['--project', 'p', 'support', '--region', 'europe-west1'], {}),
  ).toMatchObject({
    instance: 'support',
    project: 'p',
    region: 'europe-west1',
  });
  expect(() => parseCliArgs(['a', 'b'], {})).toThrow('at most one instance');
});

test('takes --resume with or without a session id', () => {
  expect(parseCliArgs(['--resume'], {}).resume).toBe('');
  expect(parseCliArgs(['--resume', '--logout'], {})).toMatchObject({
    resume: '',
    logout: true,
  });
  expect(parseCliArgs(['--resume', 's1'], {}).resume).toBe('s1');
  expect(parseCliArgs(['--resume=s2'], {}).resume).toBe('s2');
  expect(parseCliArgs([], {}).resume).toBeUndefined();
});

test('an unknown option is a usage error with its own title', () => {
  const err = (() => {
    try {
      parseCliArgs(['--nope'], {});
    } catch (e) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(UsageError);
  expect(err).toMatchObject({ title: 'Unknown option' });
});
