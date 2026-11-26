import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['tests/emulator/**/*.test.ts'],
    exclude: ['tests/emulator/app/**'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
