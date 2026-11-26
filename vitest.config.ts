import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/core/tests/unit/**/*.test.ts',
      'packages/agent-kit/tests/unit/**/*.test.ts',
      'packages/cli/tests/unit/**/*.test.{ts,tsx}',
    ],
  },
});
