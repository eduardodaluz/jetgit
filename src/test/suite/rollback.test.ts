/**
 * M6.5 integration: partial rollback against REAL git. The pipeline
 * (diffWorktreeVsHead → computeRollbackEdits → toTextEdits) runs exactly as
 * the command layer runs it, applied through a real WorkspaceEdit on a real
 * document; whole-file git primitives (checkout -- / clean -f) run with the
 * same argv the commands issue. Sandboxes pin core.autocrlf=false locally —
 * CI runners carry system autocrlf=true that would smudge checkout restores.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { diffWorktreeVsHead, toTextEdits } from '../../changes/commands';
import { computeRollbackEdits, toLf, type LineEdit, type LineSelection, type RollbackAdapter } from '../../changes/rollbackQuery';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString('utf8');
}

function gitRaw(cwd: string, ...args: string[]): Buffer {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
}

/** Adapter over a real sandbox repo — same contract the commands provide. */
function adapterFor(cwd: string): RollbackAdapter {
  return {
    cwd: () => cwd,
    runReadOnly: async (args) => {
      try {
        return {
          stdout: execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], { cwd, stdio: 'pipe' }),
          stderr: '',
          code: 0,
        };
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

/** Applies rollback edits to a real document through one WorkspaceEdit, then saves. */
async function applyRollback(fileUri: vscode.Uri, edits: readonly LineEdit[]): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(fileUri);
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(fileUri, toTextEdits(doc, edits));
  const ok = await vscode.workspace.applyEdit(workspaceEdit);
  assert.ok(ok, 'applyEdit accepted the rollback');
  await doc.save();
}

/** Runs the exact pipeline the rollbackSelected command runs (selection → edits). */
async function rollbackPipeline(
  cwd: string,
  relPath: string,
  bufferText: string,
  selections: readonly LineSelection[] | null,
  space: 'old' | 'new' = 'new',
): Promise<readonly LineEdit[]> {
  const adapter = adapterFor(cwd);
  const headBytes = gitRaw(cwd, 'show', `HEAD:${relPath}`);
  const hunks = await diffWorktreeVsHead(adapter, headBytes, bufferText);
  return computeRollbackEdits(toLf(headBytes.toString('utf8')), toLf(bufferText), hunks, selections, space);
}

suite('partial rollback (M6.5)', () => {
  const cleanup: string[] = [];

  teardown(() => {
    for (const dir of cleanup.splice(0, cleanup.length)) {
      rmRfRetry(dir);
    }
  });

  function sandbox(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-rollback-'));
    git(dir, 'init', '-b', 'main');
    // Repo-local pin: checkouts run through git binaries that read repo
    // config; a CI runner with system autocrlf=true would smudge restores.
    git(dir, 'config', 'core.autocrlf', 'false');
    cleanup.push(dir);
    return dir;
  }

  test('middle of three distant hunks rolls back; the others stay byte-identical', async () => {
    const dir = sandbox();
    const head = 'l1\npad\npad\nl2\npad\npad\nl3\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), head);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    const worktree = 'L1\npad\npad\nlX\npad\npad\nL3\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), worktree);

    const fileUri = vscode.Uri.file(path.join(dir, 'f.txt'));
    const edits = await rollbackPipeline(dir, 'f.txt', worktree, [{ first: 3, last: 3 }]);
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.startLine, 3);

    await applyRollback(fileUri, edits);
    // Only the selected middle hunk reverts — L1 and L3 stay as local edits.
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'L1\npad\npad\nl2\npad\npad\nL3\n');
  });

  test('full rollback reproduces git show HEAD byte-exactly', async () => {
    const dir = sandbox();
    const head = 'alpha\nbeta\ngamma\ndelta\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), head);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'alpha\nBETA\ngamma\nDELTA\nepsilon\n');

    const edits = await rollbackPipeline(dir, 'f.txt', fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), null);
    await applyRollback(vscode.Uri.file(path.join(dir, 'f.txt')), edits);
    assert.ok(
      fs.readFileSync(path.join(dir, 'f.txt')).equals(gitRaw(dir, 'show', 'HEAD:f.txt')),
      'disk bytes must equal the HEAD blob',
    );
  });

  test('trailing-newline transitions round-trip through real TextEdits', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'a\nb');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb'); // newline removed
    fs.writeFileSync(path.join(dir, 'b.txt'), 'a\nb\n'); // newline added

    for (const rel of ['a.txt', 'b.txt']) {
      const edits = await rollbackPipeline(dir, rel, fs.readFileSync(path.join(dir, rel), 'utf8'), null);
      await applyRollback(vscode.Uri.file(path.join(dir, rel)), edits);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\nb\n', 'removed newline is restored');
    assert.ok(fs.readFileSync(path.join(dir, 'b.txt')).equals(Buffer.from('a\nb', 'utf8')), 'added newline is removed');
  });

  test('deleted line restored via old-space (left pane) selection', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nc\n');

    const edits = await rollbackPipeline(dir, 'f.txt', 'a\nc\n', [{ first: 1, last: 1 }], 'old');
    assert.equal(edits.length, 1);
    await applyRollback(vscode.Uri.file(path.join(dir, 'f.txt')), edits);
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'a\nb\nc\n');
  });

  test('partial rollback never touches the index (staged X survives)', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'two\n');
    git(dir, 'add', 'f.txt'); // stage X
    fs.writeFileSync(path.join(dir, 'f.txt'), 'three\n'); // worktree Y

    const edits = await rollbackPipeline(dir, 'f.txt', 'three\n', null);
    await applyRollback(vscode.Uri.file(path.join(dir, 'f.txt')), edits);
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'one\n', 'worktree back to HEAD');
    const cached = git(dir, 'diff', '--cached', '--name-only').trim();
    assert.equal(cached, 'f.txt', 'the staged delta vs HEAD must survive');
  });

  test('rollbackFile primitive: worktree ← index, staged state intact', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'two\n');
    git(dir, 'add', 'f.txt');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'three\n');

    // Same argv the rollbackFile command issues (single-file form).
    git(dir, 'checkout', '--', ':(literal)f.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'two\n', 'file restored to the STAGED version');
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), 'f.txt', 'index untouched');
  });

  test('untracked file removed by clean -f with literal pathspec', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'temp\n');

    git(dir, 'clean', '-f', '--', ':(literal)untracked.txt');
    assert.ok(!fs.existsSync(path.join(dir, 'untracked.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'keep.txt')));
  });

  test('locally deleted tracked file is restored byte-exact by checkout --', () => {
    const dir = sandbox();
    const head = 'content\nlines\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), head);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    fs.rmSync(path.join(dir, 'f.txt'));

    git(dir, 'checkout', '--', ':(literal)f.txt');
    assert.ok(fs.readFileSync(path.join(dir, 'f.txt')).equals(Buffer.from(head, 'utf8')));
  });

  test('CRLF file: rollback restores the middle line without \\r doubling', async () => {
    const dir = sandbox();
    const head = 'r1\r\nr2\r\nr3\r\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), Buffer.from(head, 'utf8'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    const worktree = 'r1\r\nR2\r\nr3\r\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), Buffer.from(worktree, 'utf8'));

    const edits = await rollbackPipeline(dir, 'f.txt', worktree, [{ first: 1, last: 1 }]);
    await applyRollback(vscode.Uri.file(path.join(dir, 'f.txt')), edits);
    const after = fs.readFileSync(path.join(dir, 'f.txt')).toString('utf8');
    assert.equal(after, head, 'byte-identical CRLF restore');
    assert.ok(!after.includes('\r\r'), 'no doubled carriage returns');
  });

  test('pipeline is repo-scoped: rolling back in repo A leaves repo B untouched', async () => {
    const a = sandbox();
    const b = sandbox();
    fs.writeFileSync(path.join(a, 'f.txt'), 'a1\na2\na3\n');
    fs.writeFileSync(path.join(b, 'f.txt'), 'b1\nb2\nb3\n');
    git(a, 'add', '-A');
    git(a, 'commit', '-m', 'base');
    git(b, 'add', '-A');
    git(b, 'commit', '-m', 'base');
    fs.writeFileSync(path.join(a, 'f.txt'), 'a1\nAX\na3\n');
    fs.writeFileSync(path.join(b, 'f.txt'), 'b1\nBX\nb3\n');

    const edits = await rollbackPipeline(a, 'f.txt', 'a1\nAX\na3\n', [{ first: 1, last: 1 }]);
    await applyRollback(vscode.Uri.file(path.join(a, 'f.txt')), edits);
    assert.equal(fs.readFileSync(path.join(a, 'f.txt'), 'utf8'), 'a1\na2\na3\n');
    assert.equal(fs.readFileSync(path.join(b, 'f.txt'), 'utf8'), 'b1\nBX\nb3\n', 'repo B untouched');
  });

  test('diffWorktreeVsHead exit-code contract: identical → [], one change → 1 hunk', async () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'same\nlines\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'base');
    const adapter = adapterFor(dir);
    const headBytes = gitRaw(dir, 'show', 'HEAD:f.txt');

    const identical = await diffWorktreeVsHead(adapter, headBytes, 'same\nlines\n');
    assert.deepEqual(identical, []);

    const changed = await diffWorktreeVsHead(adapter, headBytes, 'same\nchanged\n');
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0], { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, oldLines: ['lines'], newLines: ['changed'] });
  });
});
