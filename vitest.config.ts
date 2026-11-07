import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    // Git and CLI suites launch child processes; avoid oversubscribing CI hosts.
    maxWorkers: 2,
  },
});
