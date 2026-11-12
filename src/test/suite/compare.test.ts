/**
 * M6 integration: branch compare against REAL git. The acceptance check —
 * in/out counts must equal `git log --left-right --count` — runs against a
 * diverged sandbox; the file matrix maps onto the IntelliJ classes, worktree
 * mode sees uncommitted state that committed mode does not, Get from Branch
 * restores exact ref bytes, and the queries run independently against both
 * fixture repositories of the multi-root workspace.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { compareCounts, compareFiles } from '../../compare/compareQuery';
import type { BlameAdapter } from '../../blame/blameQuery';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString('utf8');
}

function commitAll(cwd: string, message: string): void {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', message);
}

/** Adapter over a real sandbox repo — same contract the service provides. */
function adapterFor(cwd: string): BlameAdapter {
  return {
    cwd: () => cwd,
    runReadOnly: async (args) => {
      try {
        return { stdout: execFileSync('git', ['-c', 'core.quotepath=false', '--no-optional-locks', ...args], { cwd, stdio: 'pipe' }), stderr: '', code: 0 };
      } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
        return { stdout: e.stdout ?? Buffer.alloc(0), stderr: e.stderr?.toString('utf8') ?? '', code: e.status ?? -1 };
      }
    },
  };
}

function rmRfRetry(dir: string, attempts = 5): void {
  for (let i = 0; i < attempts; i++) {
    try {
      clearAttributes(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) {
        throw err;
      }
      execFileSync('cmd', ['/c', 'ping', '-n', '1', '-w', '200', '127.0.0.1'], { stdio: 'ignore' });
    }
  }
}

/** git loose objects are READ-ONLY on Windows; fs.rmSync({force}) cannot clear the attribute. */
function clearAttributes(root: string): void {
  if (!fs.existsSync(root)) {
    return;
  }
  const walk = (p: string): void => {
    try {
      const stat = fs.lstatSync(p);
      fs.chmodSync(p, stat.isDirectory() ? 0o777 : 0o666);
    } catch {
      return;
    }
    if (fs.statSync(p).isDirectory()) {
      for (const entry of fs.readdirSync(p)) {
        walk(path.join(p, entry));
      }
    }
  };
  walk(root);
}

suite('compare with ref (M6)', () => {
  let sandbox: string;
  let adapter: BlameAdapter;

  setup(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-compare-'));
    adapter = adapterFor(sandbox);
    git(sandbox, 'init', '-b', 'main');

    // Base, then a feature branch with 3 commits (edit, add, rename) while
    // main gets 1 commit of its own — a real divergence in both directions.
    fs.writeFileSync(path.join(sandbox, 'base.txt'), 'base v1\n');
    commitAll(sandbox, 'base');
    git(sandbox, 'checkout', '-b', 'feature/div');
    fs.writeFileSync(path.join(sandbox, 'base.txt'), 'base v2-feature\n');
    commitAll(sandbox, 'feature: edit base');
    fs.writeFileSync(path.join(sandbox, 'feature-only.txt'), 'from feature\n');
    commitAll(sandbox, 'feature: add file');
    git(sandbox, 'mv', 'feature-only.txt', 'feature-renamed.txt');
    commitAll(sandbox, 'feature: rename file');
    git(sandbox, 'checkout', 'main');
    // Byte-identical to feature-renamed.txt on purpose: cross-branch rename
    // detection is heuristic, and identical content is the one case where
    // -M reports R100 deterministically.
    fs.writeFileSync(path.join(sandbox, 'main-only.txt'), 'from feature\n');
    commitAll(sandbox, 'main: add file');

    // Dirty working tree: base.txt edited locally, not committed.
    fs.writeFileSync(path.join(sandbox, 'base.txt'), 'local edit\n');
  });

  teardown(() => {
    rmRfRetry(sandbox);
  });

  test('in/out counts equal git rev-list --left-right --count (acceptance)', async () => {
    const counts = await compareCounts(adapter, 'feature/div');
    // git log silently IGNORES --count on current git (prints the log);
    // rev-list is the correct command for the left/right pair.
    const shell = git(sandbox, 'rev-list', '--left-right', '--count', 'HEAD...feature/div').trim();
    const [shellOut, shellIn] = shell.split('\t').map(Number);
    assert.equal(counts.outgoing, shellOut, 'outgoing must equal the shell count');
    assert.equal(counts.incoming, shellIn, 'incoming must equal the shell count');
    assert.equal(counts.outgoing, 1);
    assert.equal(counts.incoming, 3);
  });

  test('committed matrix maps onto the IntelliJ classes with rename detection', async () => {
    const files = await compareFiles(adapter, 'feature/div', 'committed');
    const byPath = new Map(files.map((f) => [f.path, f]));
    assert.deepEqual(
      files.map((f) => `${f.status}:${f.path}=${f.cls}`).sort(),
      ['M:base.txt=diff', 'R:main-only.txt=diff'],
    );
    const renamed = byPath.get('main-only.txt');
    assert.equal(renamed?.status, 'R');
    assert.equal(renamed?.oldPath, 'feature-renamed.txt');
  });

  test('worktree mode sees uncommitted state that committed mode does not', async () => {
    fs.rmSync(path.join(sandbox, 'base.txt')); // delete uncommitted
    const committed = await compareFiles(adapter, 'feature/div', 'committed');
    assert.ok(committed.some((f) => f.path === 'base.txt' && f.status === 'M'), 'committed mode still shows base.txt (tip content)');

    const worktree = await compareFiles(adapter, 'feature/div', 'worktree');
    const base = worktree.find((f) => f.path === 'base.txt');
    assert.equal(base?.status, 'D', 'worktree mode sees the local deletion');
    assert.equal(base?.cls, 'ref');
    const paired = worktree.find((f) => f.path === 'main-only.txt');
    assert.equal(paired?.status, 'R', 'identical content pairs the rename across the working-tree diff too');
    assert.equal(paired?.oldPath, 'feature-renamed.txt');
    assert.equal(paired?.cls, 'diff');
  });

  test('Get from Branch primitive restores exact ref bytes (edit + deletion)', async () => {
    execFileSync('git', ['checkout', 'feature/div', '--', 'base.txt'], { cwd: sandbox, stdio: 'pipe' });
    assert.equal(fs.readFileSync(path.join(sandbox, 'base.txt'), 'utf8'), 'base v2-feature\n');

    fs.rmSync(path.join(sandbox, 'base.txt')); // locally deleted
    execFileSync('git', ['checkout', 'feature/div', '--', 'base.txt'], { cwd: sandbox, stdio: 'pipe' });
    assert.equal(fs.readFileSync(path.join(sandbox, 'base.txt'), 'utf8'), 'base v2-feature\n', 'deleted file is recreated from the ref');
  });

  test('queries run independently against each fixture repo (multi-root)', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const byName = new Map(folders.map((f) => [path.basename(f.uri.fsPath), f.uri.fsPath]));
    const repoA = byName.get('repo-a');
    const repoB = byName.get('repo-b');
    assert.ok(repoA && repoB, 'the multi-root fixture workspace is open');

    // repo-a: diverged fixture — main carries 1 exclusive commit, the
    // feature branch carries 2.
    const countsA = await compareCounts(adapterFor(repoA), 'feature/diverged');
    assert.deepEqual(countsA, { outgoing: 1, incoming: 2 });

    // repo-b: independent repo in the same workspace — no divergence.
    const countsB = await compareCounts(adapterFor(repoB), 'main');
    assert.deepEqual(countsB, { outgoing: 0, incoming: 0 });
    const filesB = await compareFiles(adapterFor(repoB), 'main', 'committed');
    assert.deepEqual(filesB, [], 'identical tips produce an empty matrix');
  });
});
