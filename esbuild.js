const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const withTests = process.argv.includes('--test');

const BUNDLE_SIZE_LIMIT = 1024 * 1024; // 1 MB hard tripwire

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const testOptions = {
  entryPoints: [
    { in: 'src/test/runTest.ts', out: 'test/runTest' },
    { in: 'src/test/suite/index.ts', out: 'test/suite/index' },
    { in: 'src/test/suite/activation.test.ts', out: 'test/suite/activation.test' },
    { in: 'src/test/suite/changelists.test.ts', out: 'test/suite/changelists.test' },
  ],
  outdir: 'dist',
  // Each test file bundles its own imports (src/ modules live inside the
  // extension bundle, so unbundled relative imports would not resolve), but
  // `mocha` and `vscode` stay external: mocha must be required from
  // node_modules at runtime so its addFile/pre-require binding works, and
  // `vscode` is provided by the extension host.
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode', 'mocha'],
  // Tests are never minified and keep sourcemaps for extension-host debugging.
  minify: false,
  sourcemap: true,
  logLevel: 'info',
};

function reportSizes(label, result) {
  for (const [file, info] of Object.entries(result.metafile.outputs)) {
    console.log(`[esbuild] ${label}: ${file} (${(info.bytes / 1024).toFixed(1)} KiB)`);
    if (production && info.bytes > BUNDLE_SIZE_LIMIT) {
      throw new Error(`[esbuild] ${file} exceeds the ${BUNDLE_SIZE_LIMIT / 1024} KiB tripwire (${info.bytes} bytes)`);
    }
  }
}

async function buildOnce() {
  const ext = await esbuild.build({ ...extensionOptions, metafile: true });
  reportSizes('extension', ext);
  if (withTests) {
    const tests = await esbuild.build({ ...testOptions, metafile: true });
    reportSizes('tests', tests);
  }
}

if (watch) {
  const contexts = [];
  esbuild
    .context(extensionOptions)
    .then((ctx) => {
      contexts.push(ctx);
      if (withTests) {
        return esbuild.context(testOptions);
      }
      return undefined;
    })
    .then((testCtx) => {
      if (testCtx) {
        contexts.push(testCtx);
      }
      for (const ctx of contexts) {
        ctx.watch();
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  buildOnce().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
