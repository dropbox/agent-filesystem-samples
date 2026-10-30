import {defineConfig} from 'vitest/config';

export default defineConfig({
  // The live tests in test/e2e need a token server; npm run test:e2e runs them.
  test: {include: ['test/**/*.test.ts'], exclude: ['test/e2e/**', '**/node_modules/**']},
});
