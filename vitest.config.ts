import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'contract',
          include: ['tests/contracts/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
