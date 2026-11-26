import { rmSync } from 'node:fs';
import { build } from 'esbuild';

/** Drops Ink's React DevTools hook, which the CLI never enables. */
const noDevtools = {
  name: 'no-devtools',
  setup(b) {
    b.onResolve({ filter: /^\.\/devtools\.js$/ }, (args) =>
      args.importer.includes('/ink/')
        ? { path: 'devtools', namespace: 'empty' }
        : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({
      contents: 'export {};',
    }));
  },
};

rmSync('lib', { recursive: true, force: true });

// One self-contained file: npx then installs nothing besides this package.
await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'lib/bin.js',
  bundle: true,
  platform: 'node',
  target: 'node22.12',
  format: 'esm',
  plugins: [noDevtools],
  define: { 'process.env.NODE_ENV': '"production"' },
  // Bundled CommonJS dependencies call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'eof',
  logLevel: 'warning',
});
