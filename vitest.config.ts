import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'packages/agent-kit/tests/unit/**/*.test.ts',
    ],
  },
});
