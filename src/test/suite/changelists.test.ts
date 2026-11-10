/**
 * M2 integration: changelists commit semantics against REAL git —
 * commit --only commits exactly the member files, preserves foreign staging,
 * and the untracked-add rollback path restores exact status. The vscode.git
 * bridge itself is exercised by the M1 activation suite (these run under
 * --disable-extensions, which also proves the degradation path).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { keyFor, toRepoRel } from '../../common/paths';
import * as model from '../../changelists/model';

const fixturesDir = process.env.JETGIT_FIXTURES_DIR ?? os.tmpdir();
const repoARoot = path.join(fixturesDir, 'repo-a');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixtures', '-c', 'user.email=fixtures@jetgit.test', ...args], {
    cwd,
    stdio: 'pipe',
  }).toString('utf8');
}

/**
 * Windows-tolerant recursive delete. Git writes loose objects/packs as
 * READ-ONLY files on Windows and Node's `force: true` does not clear the
 * attribute — clear it first, then remove, retrying against transient
 * AV-scanner locks.
 */
function rmRfRetry(dir: string, attempts = 5): void {
  const clearAttributes = (root: string): void => {
    if (!fs.existsSync(root)) {
      return;
    }
    const walk = (p: string): void => {
      try {
        const stat = fs.lstatSync(p);
        // chmod(0o666/0o777) clears the Windows read-only attribute.
        fs.chmodSync(p, stat.isDirectory() ? 0o777 : 0o666);
      } catch {
        return; // already gone or unopenable — rmSync's force handles it
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
      const wait = (i + 1) * 100;
      execFileSync('cmd', ['/c', 'ping', '-n', '1', '-w', wait.toString(), '127.0.0.1'], { stdio: 'ignore' });
    }
  }
}

suite('changelists commit semantics (M2)', () => {
  test('commit --only commits exactly the member files and preserves foreign staging', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-commitcl-'));
    try {
      git(sandbox, 'init', '-b', 'main');
      fs.writeFileSync(path.join(sandbox, 'a.txt'), 'a1\n');
      fs.writeFileSync(path.join(sandbox, 'b.txt'), 'b1\n');
      git(sandbox, 'add', '-A');
      git(sandbox, 'commit', '-m', 'base');

      // Work on two files; stage b.txt BEFORE the partial commit (foreign index).
      fs.writeFileSync(path.join(sandbox, 'a.txt'), 'a2\n');
      fs.writeFileSync(path.join(sandbox, 'b.txt'), 'b2\n');
      git(sandbox, 'add', 'b.txt');

      const state = model.createState();
      const withMember = { ...state, changelists: [{ ...state.changelists[0]!, files: ['a.txt'] }] };
      const members = model.membersWithChanges(withMember, model.DEFAULT_CL_ID, ['a.txt', 'b.txt']);
      assert.deepEqual(members, ['a.txt']);

      const msgPath = path.join(os.tmpdir(), `jetgit-msg-${Date.now()}.txt`);
      fs.writeFileSync(msgPath, 'feat: partial commit of a.txt');
      git(sandbox, 'commit', '--only', `--file=${msgPath}`, 'a.txt');

      // a.txt committed with the new content…
      assert.match(git(sandbox, 'show', 'HEAD:a.txt'), /a2/);
      // …b.txt NOT included in the commit…
      assert.match(git(sandbox, 'show', 'HEAD:b.txt'), /b1/);
      // …and b.txt's staged state (foreign index entry) SURVIVED the partial commit.
      assert.match(git(sandbox, 'diff', '--cached', '--name-only'), /b\.txt/, 'foreign staged file must remain staged');
      fs.rmSync(msgPath, { force: true });
    } finally {
      rmRfRetry(sandbox);
    }
  });

  test('failed commit rolls back untracked adds exactly', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-rollback-'));
    try {
      git(sandbox, 'init', '-b', 'main');
      fs.writeFileSync(path.join(sandbox, 'tracked.txt'), 'v1\n');
      git(sandbox, 'add', '-A');
      git(sandbox, 'commit', '-m', 'base');
      // Untracked member + a pre-commit hook that fails.
      fs.writeFileSync(path.join(sandbox, 'new.txt'), 'untracked\n');
      fs.mkdirSync(path.join(sandbox, '.git', 'hooks'), { recursive: true });
      const hook = path.join(sandbox, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
      if (process.platform !== 'win32') {
        fs.chmodSync(hook, 0o755);
      }

      git(sandbox, 'add', 'new.txt');
      let failed = false;
      try {
        git(sandbox, 'commit', '--only', '-m', 'should fail', 'new.txt');
      } catch {
        failed = true;
      }
      assert.ok(failed, 'commit must fail through the failing hook');
      git(sandbox, 'reset', '-q', 'new.txt');
      const status = git(sandbox, 'status', '--porcelain');
      assert.match(status, /^\?\? new\.txt/m, 'new.txt must be untracked again after rollback');
    } finally {
      rmRfRetry(sandbox);
    }
  });

  test('fixture repo-a is present and dirty', () => {
    assert.ok(fs.existsSync(repoARoot), 'fixture repo-a must exist (run build-fixtures.mjs)');
    assert.ok(fs.existsSync(path.join(repoARoot, 'untracked.txt')), 'untracked.txt fixture must exist');
    const worktreeRoot = path.join(fixturesDir, 'repo-a-wt');
    assert.ok(fs.existsSync(worktreeRoot), 'linked worktree fixture must exist');
    // The worktree's gitdir is a FILE pointing into repo-a/.git/worktrees/…
    assert.ok(fs.statSync(path.join(worktreeRoot, '.git')).isFile(), 'worktree .git must be a file');
  });

  test('paths helpers agree with fixture layout', () => {
    assert.equal(toRepoRel(path.join(repoARoot, 'src', 'main.ts'), repoARoot), 'src/main.ts');
    assert.equal(keyFor('src/MAIN.ts'), process.platform === 'win32' ? 'src/main.ts' : 'src/MAIN.ts');
  });
});
