import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Integration tests live under src/test/ and run inside the extension host
    // via @vscode/test-electron + mocha — vitest must never pick them up.
    exclude: ['src/test/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    // Parsers deal with %x1f/%x1e records and binary buffers; keep assertions strict.
    strict: true,
  },
});
