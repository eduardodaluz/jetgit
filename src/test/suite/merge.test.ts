/**
 * M6.8 integration: the merge conflict experience against REAL git — a real
 * merge conflict, real Accept Yours/Theirs (resolution IS staging), a real
 * two-parent merge commit, aborts, modify/delete plans, cherry-pick and
 * rebase operations. MergeService is constructed DIRECTLY with a structural
 * RepoHandle: the service only uses repo.rootUri/fsPath, repo.cli and
 * repo.onDidChangeState — never the vscode.git repository API — so the fake
 * needs exactly those three members (documented, intentional cast).
 *
 * Sandbox discipline mirrors partialCommit.test.ts: repo-local autocrlf=false
 * pin (CI runners carry system autocrlf=true) and user.name/email pins (the
 * extension's GitCli spawns `git commit` WITHOUT per-invocation -c user.*).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { GitCli } from '../../git/gitCli';
import { MergeService } from '../../merge/service';
import type { RepoHandle } from '../../git/gitApi';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString('utf8');
}

/** Runs git expecting a CONFLICT (exit 1) — a clean exit or a hard error fails the test. */
function gitExpectsConflict(cwd: string, ...args: string[]): void {
  try {
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
  } catch (err) {
    const status = (err as { status?: number }).status;
    assert.equal(status, 1, `expected git ${args.join(' ')} to hit a conflict (exit 1)`);
    return;
  }
  assert.fail(`expected git ${args.join(' ')} to hit a conflict, but it succeeded`);
}

function rmRfRetry(dir: string, attempts = 8): void {
  const clearAttributes = (root: string): void => {
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
  };
  for (let i = 0; i < attempts; i++) {
    try {
      clearAttributes(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) {
        throw err;
      }
      execFileSync('cmd', ['/c', 'ping', '-n', '1', '-w', '400', '127.0.0.1'], { stdio: 'ignore' });
    }
  }
}

/** Structural RepoHandle — see the file comment for why the cast is sound. */
function repoHandleFor(dir: string): RepoHandle {
  return {
    rootUri: vscode.Uri.file(dir),
    cli: new GitCli(() => 'git'),
    onDidChangeState: () => ({ dispose(): void {} }),
  } as unknown as RepoHandle;
}

function serviceFor(dir: string): MergeService {
  return new MergeService(repoHandleFor(dir), path.join(dir, '.git'));
}

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-merge-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@t');
  return dir;
}

/** Two branches edit line 1 of shared.txt; merging feature into main conflicts (UU). */
function seedContentConflict(dir: string): void {
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'feature\n');
  git(dir, 'commit', '-qam', 'feature change');
  git(dir, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'main\n');
  git(dir, 'commit', '-qam', 'main change');
}

function triggerMergeConflict(dir: string): void {
  gitExpectsConflict(dir, 'merge', 'feature');
}

suite('merge conflict experience (M6.8)', () => {
  const cleanup: string[] = [];

  teardown(() => {
    for (const dir of cleanup.splice(0, cleanup.length)) {
      rmRfRetry(dir);
    }
  });

  test('no operation in progress → snapshot undefined (clean tree)', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    const service = serviceFor(dir);
    await service.ready();
    assert.equal(service.snapshot, undefined);
  });

  test('probe: real merge conflict reports operation merge + UU entry', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    seedContentConflict(dir);
    triggerMergeConflict(dir);
    const service = serviceFor(dir);
    await service.ready();
    assert.equal(service.snapshot?.operation, 'merge');
    assert.deepEqual(
      service.snapshot?.conflicts.map((c) => ({ path: c.path, code: c.code })),
      [{ path: 'shared.txt', code: 'UU' }],
    );
  });

  test('accept theirs: no unmerged left, path staged, worktree byte-equals theirs', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    seedContentConflict(dir);
    triggerMergeConflict(dir);
    const service = serviceFor(dir);
    await service.ready();

    await service.resolve(['shared.txt'], 'theirs');

    assert.equal(git(dir, 'ls-files', '-u').trim(), '', 'no unmerged index stages remain');
    assert.ok(
      fs.readFileSync(path.join(dir, 'shared.txt')).equals(Buffer.from('feature\n', 'utf8')),
      'worktree holds the THEIRS bytes',
    );
    assert.ok(git(dir, 'status', '--porcelain=v1').includes('M  shared.txt'), 'the resolution is STAGED');
    assert.equal(service.snapshot?.conflicts.length, 0, 'snapshot refreshed to resolved-ready');
    assert.equal(service.snapshot?.operation, 'merge', 'operation still in progress until the commit');
  });

  test('accept yours: symmetric — worktree byte-equals ours, single stage-0 entry', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    seedContentConflict(dir);
    triggerMergeConflict(dir);
    const service = serviceFor(dir);
    await service.ready();

    await service.resolve(['shared.txt'], 'ours');

    assert.equal(git(dir, 'ls-files', '-u').trim(), '');
    assert.ok(fs.readFileSync(path.join(dir, 'shared.txt')).equals(Buffer.from('main\n', 'utf8')));
    // Ours IS the HEAD side here, so staging it yields a clean status — the
    // resolution is still visible as exactly one stage-0 index entry.
    const stage = git(dir, 'ls-files', '-s', '--', 'shared.txt').trim();
    assert.match(stage, /^\d{6} [0-9a-f]{40} 0\tshared\.txt$/);
  });

  test('completeMerge: two-parent merge commit, MERGE_HEAD gone, snapshot undefined', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    seedContentConflict(dir);
    triggerMergeConflict(dir);
    const service = serviceFor(dir);
    await service.ready();
    await service.resolve(['shared.txt'], 'theirs');

    await service.completeMerge('merge feature branch');

    const parents = git(dir, 'rev-list', '--parents', '-1', 'HEAD').trim().split(' ');
    assert.equal(parents.length, 3, 'the merge commit has TWO parents');
    assert.equal(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')), false);
    assert.equal(git(dir, 'log', '-1', '--pretty=%s').trim(), 'merge feature branch');
    assert.equal(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'feature\n');
    await service.ready();
    assert.equal(service.snapshot, undefined, 'no operation left — the banner node disappears');
  });

  test('completeMerge refuses while conflicts remain', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    seedContentConflict(dir);
    triggerMergeConflict(dir);
    const service = serviceFor(dir);
    await service.ready();
    await assert.rejects(() => service.completeMerge('premature'), /conflict/);
    assert.equal(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')), true, 'the operation was not disturbed');
  });

  test('abort: pre-merge HEAD restored, worktree back to ours, no snapshot', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    seedContentConflict(dir);
    const preMergeHead = git(dir, 'rev-parse', 'HEAD').trim();
    triggerMergeConflict(dir);
    const service = serviceFor(dir);
    await service.ready();
    assert.equal(service.snapshot?.operation, 'merge');

    await service.abort();

    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), preMergeHead, 'HEAD untouched by the aborted merge');
    assert.equal(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'main\n', 'worktree restored');
    assert.equal(git(dir, 'ls-files', '-u').trim(), '');
    assert.equal(service.snapshot, undefined);
  });

  test('modify/delete (UD): accept theirs removes the file via git rm', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\n');
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'deleter');
    git(dir, 'rm', '-q', 'gone.txt');
    git(dir, 'commit', '-qm', 'delete gone.txt');
    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'y\n');
    git(dir, 'commit', '-qam', 'modify gone.txt');
    gitExpectsConflict(dir, 'merge', 'deleter');

    const service = serviceFor(dir);
    await service.ready();
    assert.deepEqual(service.snapshot?.conflicts, [{ path: 'gone.txt', code: 'UD' }]);

    await service.resolve(['gone.txt'], 'theirs');

    assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false, 'worktree file removed');
    assert.equal(git(dir, 'ls-files', '--', 'gone.txt').trim(), '', 'index entry removed');
    assert.equal(service.snapshot?.conflicts.length, 0);
  });

  test('cherry-pick conflict: operation cherry-pick, plain commit clears CHERRY_PICK_HEAD', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'picksrc');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nSIDE\nc\n');
    git(dir, 'commit', '-qam', 'side change');
    const picked = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nMAIN\nc\n');
    git(dir, 'commit', '-qam', 'main change');
    gitExpectsConflict(dir, 'cherry-pick', picked);

    const service = serviceFor(dir);
    await service.ready();
    assert.equal(service.snapshot?.operation, 'cherry-pick');
    assert.deepEqual(service.snapshot?.conflicts, [{ path: 'f.txt', code: 'UU' }]);

    await service.resolve(['f.txt'], 'theirs');
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'a\nSIDE\nc\n');

    await service.completeMerge('cherry picked');
    assert.equal(fs.existsSync(path.join(dir, '.git', 'CHERRY_PICK_HEAD')), false);
    assert.equal(git(dir, 'log', '-1', '--pretty=%s').trim(), 'cherry picked');
    await service.ready();
    assert.equal(service.snapshot, undefined);
  });

  test('rebase conflict: operation rebase, abort restores the pre-rebase branch', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'topic');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nTOPIC\nc\n');
    git(dir, 'commit', '-qam', 'topic change');
    const preRebaseHead = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nMAIN\nc\n');
    git(dir, 'commit', '-qam', 'main change');
    git(dir, 'checkout', '-q', 'topic');
    gitExpectsConflict(dir, 'rebase', 'main');

    const service = serviceFor(dir);
    await service.ready();
    assert.equal(service.snapshot?.operation, 'rebase');
    assert.deepEqual(service.snapshot?.conflicts, [{ path: 'f.txt', code: 'UU' }]);

    await service.abort();

    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), preRebaseHead, 'back to the pre-rebase topic commit');
    assert.equal(fs.existsSync(path.join(dir, '.git', 'rebase-merge')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'a\nTOPIC\nc\n');
    assert.equal(service.snapshot, undefined);
  });

  test('rebase conclude: resolve theirs + continueRebase completes without an editor', async () => {
    const dir = sandbox();
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'topic');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nTOPIC\nc\n');
    git(dir, 'commit', '-qam', 'topic change');
    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nMAIN\nc\n');
    git(dir, 'commit', '-qam', 'main change');
    git(dir, 'checkout', '-q', 'topic');
    gitExpectsConflict(dir, 'rebase', 'main');

    const service = serviceFor(dir);
    await service.ready();
    // Rebase sides: ours = the new base (MAIN), theirs = the replayed commit (TOPIC).
    await service.resolve(['f.txt'], 'theirs');
    await service.continueRebase();

    assert.equal(fs.existsSync(path.join(dir, '.git', 'rebase-merge')), false);
    assert.equal(git(dir, 'log', '-1', '--pretty=%s').trim(), 'topic change', 'the replayed commit concluded');
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'a\nTOPIC\nc\n');
    assert.equal(service.snapshot, undefined);
  });
});
