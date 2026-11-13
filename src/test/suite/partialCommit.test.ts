/**
 * M6.7 integration: the temp-index partial commit against REAL git —
 * commit exactly the included hunks while the WORKTREE and the user's real
 * index stay untouched; hooks still block; CRLF survives; headless repos
 * (initial commit) work. Mirrors rollback.test.ts sandbox discipline
 * (repo-local autocrlf=false pin — CI runners carry autocrlf=true).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { GitCli } from '../../git/gitCli';
import { allSignatures } from '../../changes/hunkSelection';
import { commitPartial, diffWorktreeVsHead, type PartialCommitRepo } from '../../changes/partialCommit';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString('utf8');
}

function gitRaw(cwd: string, ...args: string[]): Buffer {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
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

function repoFor(dir: string): PartialCommitRepo {
  return { rootUri: vscode.Uri.file(dir), cli: new GitCli(() => 'git') };
}

/** Real hunks for a worktree file vs HEAD (the same pipeline the commands run). */
async function hunksFor(dir: string, rel: string, diskText: string) {
  const repo = repoFor(dir);
  const headBytes = gitRaw(dir, 'show', `HEAD:${rel}`);
  return diffWorktreeVsHead(
    { cwd: () => dir, runReadOnly: async (args) => repo.cli.runReadOnly(dir, args) },
    headBytes,
    diskText,
  );
}

suite('partial commit via temp index (M6.7)', () => {
  const cleanup: string[] = [];

  teardown(() => {
    for (const dir of cleanup.splice(0, cleanup.length)) {
      rmRfRetry(dir);
    }
  });

  function sandbox(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-partial-'));
    git(dir, 'init', '-b', 'main');
    // Repo-local pins: autocrlf=false (CI runners carry system autocrlf=true)
    // and an identity — the extension's GitCli spawns `git commit` WITHOUT
    // per-invocation -c user.* (in production the user's global config
    // provides it).
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@t');
    cleanup.push(dir);
    return dir;
  }

  test('multi-file: partial A + whole B + untracked C — exact HEAD content, worktree and index untouched', async () => {
    const dir = sandbox();
    const headA = 'l1\nl2\nl3\nl4\nl5\nl6\n';
    fs.writeFileSync(path.join(dir, 'a.txt'), headA);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');

    const workA = 'l1\nL2\nl3\nl4\nL5\nl6\n'; // two separated changes
    fs.writeFileSync(path.join(dir, 'a.txt'), workA);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b2\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'untracked\n'); // untracked member

    const sigs = allSignatures(await hunksFor(dir, 'a.txt', workA));
    const plan = new Map([['a.txt', new Set([sigs[1]!])]]); // include ONLY the l5 change
    const result = await commitPartial(repoFor(dir), ['a.txt', 'b.txt', 'c.txt'], plan, 'feat: partial');

    assert.deepEqual(result.placed.sort(), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(gitRaw(dir, 'show', 'HEAD:a.txt').toString('utf8'), 'l1\nl2\nl3\nl4\nL5\nl6\n', 'excluded hunk reverted to HEAD in the commit');
    assert.equal(gitRaw(dir, 'show', 'HEAD:b.txt').toString('utf8'), 'b2\n');
    assert.equal(gitRaw(dir, 'show', 'HEAD:c.txt').toString('utf8'), 'untracked\n');
    // Worktree NEVER touched:
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), workA);
    // Real index clean for committed paths:
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '', 'no staged delta remains');
    // Status shows the remainder as unstaged:
    assert.match(git(dir, 'status', '--porcelain'), /^ M a\.txt/m, 'the excluded hunk stays as a local edit');
  });

  test('foreign staged delta on a NON-member survives', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\n');
    fs.writeFileSync(path.join(dir, 'd.txt'), 'd1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
    fs.writeFileSync(path.join(dir, 'd.txt'), 'd2\n');
    git(dir, 'add', 'd.txt'); // foreign staged delta

    await commitPartial(repoFor(dir), ['a.txt'], new Map(), 'feat: whole a only');
    assert.match(git(dir, 'diff', '--cached', '--name-only'), /d\.txt/, 'foreign staged delta survives');
  });

  test('partial member with a pre-existing staged delta: consumed and reported (E.3)', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nL2\nl3\n');
    git(dir, 'add', 'a.txt'); // staged delta that will be consumed by the sync

    const sigs = allSignatures(await hunksFor(dir, 'a.txt', 'l1\nL2\nl3\n'));
    const plan = new Map([['a.txt', new Set(sigs)]]);
    const result = await commitPartial(repoFor(dir), ['a.txt'], plan, 'feat: consume staged');
    assert.deepEqual(result.consumedStaged, ['a.txt']);
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
  });

  test('failing pre-commit hook blocks everything, nothing mutated', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nL2\nl3\n');
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(hook, 0o755);
    }

    const sigs = allSignatures(await hunksFor(dir, 'a.txt', 'l1\nL2\nl3\n'));
    await assert.rejects(
      () => commitPartial(repoFor(dir), ['a.txt'], new Map([['a.txt', new Set(sigs)]]), 'should fail'),
      /hook|pre-commit|failed/i,
    );
    // Refs, real index and worktree all intact:
    assert.match(git(dir, 'show', 'HEAD:a.txt'), /l2/);
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'l1\nL2\nl3\n');
  });

  test('CRLF partial commit lands CRLF-exact blobs', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'f.txt'), Buffer.from('r1\r\nr2\r\nr3\r\n', 'utf8'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    const work = 'r1\r\nR2\r\nr3\r\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), Buffer.from(work, 'utf8'));

    const sigs = allSignatures(await hunksFor(dir, 'f.txt', work));
    await commitPartial(repoFor(dir), ['f.txt'], new Map([['f.txt', new Set(sigs)]]), 'feat: crlf');
    assert.ok(gitRaw(dir, 'show', 'HEAD:f.txt').equals(Buffer.from(work, 'utf8')), 'blob byte-exact CRLF');
    assert.ok(!gitRaw(dir, 'show', 'HEAD:f.txt').toString('utf8').includes('\r\r'), 'no doubled carriage returns');
  });

  test('locally deleted tracked member commits the deletion', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'content\n');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.rmSync(path.join(dir, 'gone.txt'));

    const result = await commitPartial(repoFor(dir), ['gone.txt', 'keep.txt'], new Map(), 'chore: delete');
    assert.deepEqual(result.deleted, ['gone.txt']);
    assert.throws(() => gitRaw(dir, 'show', 'HEAD:gone.txt'), /does not exist|fatal/i);
    assert.ok(!fs.existsSync(path.join(dir, 'gone.txt')));
  });

  test('headless repo (initial commit) via read-tree --empty', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n');
    // No HEAD exists — the partial plan is inert; the whole file commits.
    const result = await commitPartial(repoFor(dir), ['new.txt'], new Map(), 'initial');
    assert.deepEqual(result.placed, ['new.txt']);
    assert.equal(gitRaw(dir, 'show', 'HEAD:new.txt').toString('utf8'), 'fresh\n');
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
  });

  test('stale signatures: nothing joins, nothing happens', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nL2\n');

    const before = git(dir, 'show', 'HEAD:a.txt');
    const result = await commitPartial(repoFor(dir), ['a.txt'], new Map([['a.txt', new Set(['deadbeef#0'])]]), 'nothing');
    assert.equal(result.placed.length, 0);
    assert.equal(result.stale.length, 1);
    assert.equal(git(dir, 'show', 'HEAD:a.txt'), before);
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '');
  });
});
