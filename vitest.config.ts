import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'infra/*/test/**/*.test.ts'],
        },
      },
      {
        // Haqiqiy Electron (xvfb/ekran kerak): `pnpm test`ga kirmaydi, alohida ishga tushiriladi.
        test: {
          name: 'companion-e2e',
          include: ['apps/companion/e2e/**/*.e2e.ts'],
          testTimeout: 90_000,
          hookTimeout: 120_000,
          fileParallelism: false,
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
