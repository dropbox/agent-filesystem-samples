import {defineConfig} from 'vitest/config';

// Local live e2e tests against real Dropbox, through the token server at
// FOLDERSYNC_E2E_TOKEN_SERVER. Files run one at a time, since each signs in its
// own managed users.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    globalSetup: ['test/e2e/setup.ts'],
    reporters: ['default', './test/e2e/logReporter.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
