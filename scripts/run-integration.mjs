/**
 * Integration test launcher wrapper: generates fixture repos into a FIXED
 * project-local directory, exports JETGIT_FIXTURES_DIR for the child, and
 * runs the bundled test launcher. `npm run test:integration` is now
 * self-sufficient — no manual env setup.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturesDir = path.join(root, '.test-fixtures');
process.env.JETGIT_FIXTURES_DIR = fixturesDir;

const build = spawnSync('node', [path.join(root, 'scripts', 'build-fixtures.mjs')], { stdio: 'inherit', env: process.env });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
const run = spawnSync('node', [path.join(root, 'dist', 'test', 'runTest.js')], { stdio: 'inherit', env: process.env });
process.exit(run.status ?? 1);
