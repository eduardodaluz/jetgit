import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Unit tests may transitively import modules that `import * as vscode`
      // (e.g. common/log via stores) — resolve to a local stub.
      vscode: fileURLToPath(new URL('./src/test/mocks/vscode-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Integration tests live under src/test/ and run inside the extension host
    // via @vscode/test-electron + mocha — vitest must never pick them up.
    exclude: ['src/test/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    strict: true,
  },
});
