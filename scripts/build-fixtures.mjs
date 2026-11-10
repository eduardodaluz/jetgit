/**
 * Generates the git fixture repositories used by integration tests.
 * Run before launching @vscode/test-electron; JETGIT_FIXTURES_DIR receives
 * the output directory. Deterministic content — tests assert byte-exact
 * round-trips.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fixturesDir = process.env.JETGIT_FIXTURES_DIR ?? path.join(os.tmpdir(), `jetgit-fixtures-${Date.now()}`);
fs.rmSync(fixturesDir, { recursive: true, force: true });
fs.mkdirSync(fixturesDir, { recursive: true });

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=Fixtures', '-c', 'user.email=fixtures@jetgit.test', ...args], { cwd, stdio: 'pipe' });
}

function write(cwd, rel, content) {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commitAll(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', message);
}

// repo-a: tracked, untracked, binary, CRLF, unicode filename, 5+ commits,
// and a branch diverged 2 commits each way (compare in/out fixture).
const repoA = path.join(fixturesDir, 'repo-a');
fs.mkdirSync(repoA);
git(repoA, 'init', '-b', 'main');
write(repoA, 'src/main.ts', 'export function main(): void {\n  console.log("v1");\n}\n');
write(repoA, 'docs/readme.md', '# repo-a\n\nfirst version\n');
write(repoA, 'img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x01]));
commitAll(repoA, 'chore: initial');
write(repoA, 'src/main.ts', 'export function main(): void {\n  console.log("v2");\n}\n');
commitAll(repoA, 'feat: v2 of main');
write(repoA, 'src/helper.ts', 'export const helper = 1;\n');
commitAll(repoA, 'feat: helper');
write(repoA, 'docs/readme.md', '# repo-a\n\nsecond version\n');
commitAll(repoA, 'docs: readme v2');
write(repoA, 'src/app.test.ts', 'test("app", () => expect(1).toBe(1));\n');
commitAll(repoA, 'test: app test');
git(repoA, 'checkout', '-b', 'feature/diverged');
write(repoA, 'src/feature.ts', 'export const feature = true;\n');
commitAll(repoA, 'feat: feature branch commit 1');
write(repoA, 'src/feature.ts', 'export const feature = 2;\n');
commitAll(repoA, 'feat: feature branch commit 2');
git(repoA, 'checkout', 'main');
write(repoA, 'src/main-on-main.ts', 'export const mainOnly = true;\n');
commitAll(repoA, 'feat: main-only commit');
// Working tree state: one modified tracked file + one untracked + one CRLF file.
write(repoA, 'docs/readme.md', '# repo-a\n\nsecond version\n\nlocal edit (uncommitted)\n');
write(repoA, 'untracked.txt', 'untracked content\n');
write(repoA, 'crlf-file.txt', 'line one\r\nline two\r\n');

// repo-a-wt: linked worktree of repo-a (worktree-state isolation fixture).
execFileSync('git', ['worktree', 'add', '-b', 'wt-branch', path.join(fixturesDir, 'repo-a-wt')], { cwd: repoA, stdio: 'pipe' });
write(path.join(fixturesDir, 'repo-a-wt'), 'wt-file.txt', 'edited in worktree\n');

// repo-b: independent second repository (multi-root fixture).
const repoB = path.join(fixturesDir, 'repo-b');
fs.mkdirSync(repoB);
git(repoB, 'init', '-b', 'main');
write(repoB, 'other.md', '# repo-b\n');
commitAll(repoB, 'chore: initial b');

console.log(fixturesDir);
