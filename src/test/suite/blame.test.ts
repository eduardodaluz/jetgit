/**
 * M5 integration: blame queries + the jetgit-ref content provider against
 * REAL git — uncommitted lines, -w whitespace tolerance, whole-file maps,
 * commit file listing (including --root and renames), ref content, and
 * refUri round-trips through the actual vscode.Uri implementation.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { blameFile, blameLine, commitFiles, refContent, type BlameAdapter } from '../../blame/blameQuery';
import { UNCOMMITTED_SHA } from '../../git/blameParser';
import { parseRefUri, refUri, RefContentProvider } from '../../git/refContent';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString('utf8');
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

suite('blame queries + ref content (M5)', () => {
  let sandbox: string;
  let adapter: BlameAdapter;
  let baseSha: string;
  let secondSha: string;

  setup(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-blame-'));
    adapter = adapterFor(sandbox);
    git(sandbox, 'init', '-b', 'main');
    // Base commit: 5 lines.
    fs.writeFileSync(path.join(sandbox, 'a.txt'), 'line one\nline two\nline three\nline four\nline five\n');
    fs.writeFileSync(path.join(sandbox, 'b.txt'), 'other file\n');
    git(sandbox, 'add', '-A');
    git(sandbox, 'commit', '-m', 'base commit');
    baseSha = git(sandbox, 'rev-parse', 'HEAD').trim();

    // Second commit: modify a.txt line one, add c.txt.
    fs.writeFileSync(path.join(sandbox, 'a.txt'), 'line one CHANGED\nline two\nline three\nline four\nline five\n');
    fs.writeFileSync(path.join(sandbox, 'c.txt'), 'new file\n');
    git(sandbox, 'add', '-A');
    git(sandbox, 'commit', '-m', 'second commit');
    secondSha = git(sandbox, 'rev-parse', 'HEAD').trim();

    // Working tree: uncommitted edit of line two + a whitespace-only reindent of line three.
    fs.writeFileSync(path.join(sandbox, 'a.txt'), 'line one CHANGED\nline two EDITED LOCALLY\n  line three\nline four\nline five\n');
  });

  teardown(() => {
    rmRfRetry(sandbox);
  });

  test('blameLine: committed line → its commit; local edit → uncommitted sha', async () => {
    const line1 = await blameLine(adapter, 'a.txt', 1, { ignoreWhitespace: true });
    assert.equal(line1.lineToSha.get(1), secondSha);
    const commit = line1.commits.get(secondSha);
    assert.ok(commit, 'commit metadata present');
    assert.equal(commit?.summary, 'second commit');
    assert.equal(commit?.email, 't@t');

    const result = await blameLine(adapter, 'a.txt', 2, { ignoreWhitespace: true });
    assert.equal(result.lineToSha.get(2), UNCOMMITTED_SHA, 'locally edited line is uncommitted');
    assert.equal(result.commits.get(UNCOMMITTED_SHA)?.author, 'Not Committed Yet');
  });

  test('ignoreWhitespace (-w): a whitespace-only reindent still blames the last content commit', async () => {
    const withW = await blameLine(adapter, 'a.txt', 3, { ignoreWhitespace: true });
    assert.equal(withW.lineToSha.get(3), baseSha, '-w attributes re-indented line to the base commit');

    const withoutW = await blameLine(adapter, 'a.txt', 3, { ignoreWhitespace: false });
    assert.equal(withoutW.lineToSha.get(3), UNCOMMITTED_SHA, 'without -w the re-indent is uncommitted work');
  });

  test('blameFile maps every line and stays consistent with per-line blame', async () => {
    const full = await blameFile(adapter, 'a.txt', { ignoreWhitespace: true });
    assert.equal(full.lineToSha.size, 5, 'all 5 lines mapped');
    for (let line = 1; line <= 5; line++) {
      const perLine = await blameLine(adapter, 'a.txt', line, { ignoreWhitespace: true });
      assert.equal(perLine.lineToSha.get(line), full.lineToSha.get(line), `line ${line} consistent between whole-file and -L blame`);
    }
  });

  test('blame fails loudly for a file git does not know (service degrades)', async () => {
    await assert.rejects(() => blameLine(adapter, 'missing.txt', 1, { ignoreWhitespace: true }), /failed/);
    await assert.rejects(() => blameFile(adapter, 'missing.txt', { ignoreWhitespace: true }), /failed/);
  });

  test('commitFiles lists A/M/D and honors --root for the initial commit', async () => {
    const baseFiles = await commitFiles(adapter, baseSha);
    assert.deepEqual(
      baseFiles.map((f) => `${f.status}:${f.path}`).sort(),
      ['A:a.txt', 'A:b.txt'],
      '--root makes the initial commit list its files',
    );

    const secondFiles = await commitFiles(adapter, secondSha);
    assert.deepEqual(
      secondFiles.map((f) => `${f.status}:${f.path}`).sort(),
      ['A:c.txt', 'M:a.txt'],
    );
  });

  test('commitFiles reports renames with oldPath', async () => {
    git(sandbox, 'add', '-A');
    git(sandbox, 'commit', '-m', 'uncommitted prep');
    git(sandbox, 'mv', 'b.txt', 'renamed.txt');
    git(sandbox, 'add', '-A');
    git(sandbox, 'commit', '-m', 'rename commit');
    const headSha = git(sandbox, 'rev-parse', 'HEAD').trim();
    const files = await commitFiles(adapter, headSha);
    const renamed = files.find((f) => f.path === 'renamed.txt');
    assert.ok(renamed, 'rename present');
    assert.equal(renamed?.status, 'R');
    assert.equal(renamed?.oldPath, 'b.txt');
  });

  test('refContent returns exact bytes at a ref and undefined for missing pairs', async () => {
    const atBase = await refContent(adapter, baseSha, 'a.txt');
    assert.ok(atBase);
    assert.equal(atBase.toString('utf8'), 'line one\nline two\nline three\nline four\nline five\n');

    const atSecond = await refContent(adapter, secondSha, 'a.txt');
    assert.equal(atSecond?.toString('utf8'), 'line one CHANGED\nline two\nline three\nline four\nline five\n');

    assert.equal(await refContent(adapter, baseSha, 'c.txt'), undefined, 'file did not exist at base');
    assert.equal(await refContent(adapter, `${secondSha}~1`, 'c.txt'), undefined, 'parent-side miss resolves to undefined (root/parent diffs degrade)');
  });

  test('refUri round-trips through vscode.Uri and the provider serves ref content', async () => {
    const repoRoot = vscode.Uri.file(sandbox);
    const uri = refUri(repoRoot, secondSha, 'a.txt');
    assert.equal(uri.scheme, 'jetgit-ref');
    const parsed = parseRefUri(uri);
    assert.ok(parsed, 'payload parses');
    assert.equal(parsed?.repo, repoRoot.toString());
    assert.equal(parsed?.ref, secondSha);
    assert.equal(parsed?.relPath, 'a.txt');
    assert.equal(parseRefUri(vscode.Uri.parse('jetgit-ref:///x?%%%bad')), undefined, 'malformed payload → undefined');

    const provider = new RefContentProvider(async (repoKey, args) => {
      assert.equal(repoKey, repoRoot.toString(), 'provider resolves the right repo');
      return execFileSync('git', ['-c', 'core.quotepath=false', '--no-optional-locks', ...args], { cwd: sandbox, stdio: 'pipe' });
    });
    const content = await provider.provideTextDocumentContent(uri);
    assert.equal(content, 'line one CHANGED\nline two\nline three\nline four\nline five\n');

    const missing = await provider.provideTextDocumentContent(refUri(repoRoot, baseSha, 'c.txt'));
    assert.match(missing, /not available at/, 'missing ref/path degrades to an explanatory comment');
  });
});
