import { createRequire } from 'node:module';

// Both src/ and the bundled lib/ sit one level below package.json.
const pkg: unknown = createRequire(import.meta.url)('../package.json');

/** The package version. */
export const VERSION =
  typeof pkg === 'object' &&
  pkg !== null &&
  'version' in pkg &&
  typeof pkg.version === 'string'
    ? pkg.version
    : '0.0.0';
