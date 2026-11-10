/** Removes stale build outputs so old test bundles never leak into a run. */
import { rmSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/clean.mjs <dir>');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
