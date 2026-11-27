import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const examples = fileURLToPath(new URL('examples/', import.meta.url));
const agentKit = fileURLToPath(new URL('packages/agent-kit/', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/core/tests/unit/**/*.test.ts',
            'packages/agent-kit/tests/unit/**/*.test.ts',
            'packages/cli/tests/unit/**/*.test.{ts,tsx}',
          ],
        },
      },
      {
        plugins: [
          {
            name: 'example-wrapper-deps',
            enforce: 'pre',
            // The example is outside the workspace and has no node_modules.
            resolveId(id, importer) {
              if (id === '@cabljac/firebase-agent-kit') {
                return `${agentKit}tests/example/kit.ts`;
              }
              if (!importer?.startsWith(examples) || /^[./]|^node:/.test(id)) {
                return null;
              }
              return this.resolve(id, `${agentKit}package.json`, {
                skipSelf: true,
              });
            },
          },
        ],
        test: {
          name: 'example',
          include: ['packages/agent-kit/tests/example/**/*.test.ts'],
        },
      },
    ],
  },
});
