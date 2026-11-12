/**
 * M3 integration: shelf patch round-trips against REAL git through the same
 * patchBuilder the service uses — tracked/untracked/binary/deleted,
 * byte-identical restore, CRLF survival, conflict isolation, Save-to-Shelf.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildShelfPatch, revertWorkingFiles, type GitDiffAdapter } from '../../shelf/patchBuilder';
import { parsePatch } from '../../shelf/patchInfo';
import * as model from '../../shelf/model';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString('utf8');
}

function gitRaw(cwd: string, ...args: string[]): Buffer {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
}

/** Adapter over a real sandbox repo — same contract the service provides. */
function adapterFor(cwd: string): GitDiffAdapter {
  return {
    cwd: () => cwd,
    runReadOnlyChecked: async (args) => gitRaw(cwd, ...args),
    runReadOnly: async (args) => {
      try {
        return { stdout: gitRaw(cwd, ...args), stderr: '', code: 0 };
      } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
        return { stdout: e.stdout ?? Buffer.alloc(0), stderr: e.stderr?.toString('utf8') ?? '', code: e.status ?? -1 };
      }
    },
    runChecked: async (args) => gitRaw(cwd, ...args),
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

/** Applies a patch buffer per file with --3way, exactly like ShelfService.apply. */
async function applyPerFile(cwd: string, patch: Buffer): Promise<{ applied: string[]; conflicted: string[]; failed: string[] }> {
  const outcome = { applied: [] as string[], conflicted: [] as string[], failed: [] as string[] };
  for (const fileEntry of parsePatch(patch)) {
    const segment = patch.subarray(fileEntry.start, fileEntry.end);
    const tmp = path.join(os.tmpdir(), `jetgit-test-seg-${Math.random().toString(36).slice(2)}.patch`);
    fs.writeFileSync(tmp, segment);
    try {
      let code = 0;
      let stderr = '';
      try {
        execFileSync('git', ['-C', cwd, 'apply', '--3way', '--whitespace=nowarn', '--binary', tmp], { stdio: 'pipe' });
      } catch (err) {
        const e = err as { status?: number; stderr?: Buffer };
        code = e.status ?? -1;
        stderr = e.stderr?.toString('utf8') ?? '';
      }
      if (code === 0) {
        outcome.applied.push(fileEntry.path);
      } else if (code === 1) {
        void stderr;
        outcome.conflicted.push(fileEntry.path);
      } else {
        outcome.failed.push(fileEntry.path);
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return outcome;
}

suite('shelf patch round-trips (M3)', () => {
  let sandbox: string;

  setup(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-shelf-'));
    git(sandbox, 'init', '-b', 'main');
    // Repo-local pin, not per-invocation: the revert step runs through the
    // extension's own gitCli, which reads repo config — a CI runner with
    // system autocrlf=true would smudge restored files to CRLF.
    git(sandbox, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(sandbox, 'a.txt'), 'version one\n');
    fs.writeFileSync(path.join(sandbox, 'c.txt'), 'delete me\n');
    fs.writeFileSync(path.join(sandbox, 'img.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    git(sandbox, 'add', '-A');
    git(sandbox, 'commit', '-m', 'base');
  });

  teardown(() => {
    rmRfRetry(sandbox);
  });

  test('shelve→revert→apply restores tracked/untracked/binary/deleted byte-identical', async () => {
    const adapter = adapterFor(sandbox);
    // Working state: modify tracked, delete tracked, modify binary, add untracked.
    fs.writeFileSync(path.join(sandbox, 'a.txt'), 'version two — local edit\n');
    fs.rmSync(path.join(sandbox, 'c.txt'));
    fs.writeFileSync(path.join(sandbox, 'img.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x11]));
    fs.writeFileSync(path.join(sandbox, 'new.txt'), 'untracked content\n');

    const tracked = ['a.txt', 'c.txt', 'img.bin'];
    const untracked = ['new.txt'];
    const patch = await buildShelfPatch(adapter, tracked, untracked);
    const entries = parsePatch(patch);
    assert.deepEqual(
      entries.map((e) => e.path).sort(),
      ['a.txt', 'c.txt', 'img.bin', 'new.txt'],
      'patch must contain all four files',
    );

    // Shelve reverts working files…
    await revertWorkingFiles(adapter, tracked, untracked);
    assert.equal(fs.readFileSync(path.join(sandbox, 'a.txt'), 'utf8'), 'version one\n', 'tracked file restored to index');
    assert.equal(fs.existsSync(path.join(sandbox, 'c.txt')), true, 'deleted tracked file restored by checkout');
    assert.equal(fs.existsSync(path.join(sandbox, 'new.txt')), false, 'untracked file removed by clean');
    const binAfterRevert = fs.readFileSync(path.join(sandbox, 'img.bin'));
    assert.deepEqual([...binAfterRevert.subarray(4, 8)], [0x00, 0x01, 0x02, 0x03], 'binary restored');

    // …and apply puts everything back byte-identical.
    const outcome = await applyPerFile(sandbox, patch);
    assert.deepEqual(outcome.failed, [], 'no structural failures');
    assert.deepEqual(outcome.conflicted, [], 'no conflicts on clean apply');
    assert.equal(fs.readFileSync(path.join(sandbox, 'a.txt'), 'utf8'), 'version two — local edit\n');
    assert.equal(fs.readFileSync(path.join(sandbox, 'new.txt'), 'utf8'), 'untracked content\n');
    assert.deepEqual([...fs.readFileSync(path.join(sandbox, 'img.bin')).subarray(4, 8)], [0xff, 0xfe, 0x00, 0x11], 'binary byte-identical');
    assert.equal(fs.existsSync(path.join(sandbox, 'c.txt')), false, 'deletion reapplied');
  });

  test('Save to Shelf leaves working files untouched', async () => {
    const adapter = adapterFor(sandbox);
    fs.writeFileSync(path.join(sandbox, 'a.txt'), 'edited — must stay\n');
    const patch = await buildShelfPatch(adapter, ['a.txt'], []);
    void patch;
    // revert:false → do NOT call revertWorkingFiles
    assert.equal(fs.readFileSync(path.join(sandbox, 'a.txt'), 'utf8'), 'edited — must stay\n');
  });

  test('conflict isolates: one conflicting file leaves markers, the other applies', async () => {
    const adapter = adapterFor(sandbox);
    fs.writeFileSync(path.join(sandbox, 'a.txt'), 'shelf version\n');
    fs.writeFileSync(path.join(sandbox, 'c.txt'), 'keep this change\n');
    const patch = await buildShelfPatch(adapter, ['a.txt', 'c.txt'], []);
    await revertWorkingFiles(adapter, ['a.txt', 'c.txt'], []);

    // Diverge a.txt so its segment conflicts; leave c.txt clean for apply.
    fs.writeFileSync(path.join(sandbox, 'a.txt'), 'diverging local version\n');
    git(sandbox, 'add', 'a.txt');

    const outcome = await applyPerFile(sandbox, patch);
    assert.ok(outcome.conflicted.includes('a.txt'), 'a.txt must conflict');
    assert.ok(outcome.applied.includes('c.txt'), 'c.txt must apply despite the conflict');
    const aContent = fs.readFileSync(path.join(sandbox, 'a.txt'), 'utf8');
    assert.match(aContent, /<<<</, 'conflict markers present for the merge editor');
  });

  test('shelf index model: trash/restore/purge and ordering', () => {
    let index = model.createIndex();
    const now = new Date('2026-11-10T12:00:00Z');
    const later = new Date('2026-11-10T13:00:00Z');
    const e1: model.ShelfEntry = { id: 'sh-1', name: 'first', createdAt: now.toISOString(), reverted: true, files: ['a.txt'], bytes: 10, untrackedCount: 0, deletedAt: null };
    const e2: model.ShelfEntry = { id: 'sh-2', name: 'second', createdAt: later.toISOString(), reverted: false, files: ['b.txt'], bytes: 20, untrackedCount: 1, deletedAt: null };
    index = model.addEntry(index, e1);
    index = model.addEntry(index, e2);
    assert.deepEqual(model.listLive(index).map((s) => s.name), ['second', 'first'], 'newest first');

    index = model.trash(index, 'sh-2', () => later);
    assert.deepEqual(model.listLive(index).map((s) => s.name), ['first']);
    assert.equal(model.listTrash(index).length, 1);

    index = model.restore(index, 'sh-2');
    assert.equal(model.listTrash(index).length, 0);

    index = model.trash(index, 'sh-1', () => now);
    index = model.purge(index, 'sh-1');
    assert.equal(index.shelves.length, 1);
  });

  test('CRLF working-file change survives a patch round-trip byte-exact', async () => {
    // Hermetic sandbox with core.autocrlf=false: the repo never normalizes,
    // so diff/apply carry raw CRLF bytes. This pins OUR invariant — the
    // patch pipeline is byte-faithful and never translates EOLs; repos with
    // autocrlf=true get git's configured normalization, exactly as with
    // every other git operation.
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-crlf-'));
    try {
      git(sb, 'init', '-b', 'main');
      git(sb, 'config', 'core.autocrlf', 'false');
      fs.writeFileSync(path.join(sb, 'f.txt'), 'line one\nline two\n');
      git(sb, 'add', '-A');
      git(sb, 'commit', '-m', 'base');

      const modified = Buffer.from('line one\r\nline two\r\nline three added\r\n', 'utf8');
      fs.writeFileSync(path.join(sb, 'f.txt'), modified);

      const adapter = adapterFor(sb);
      const patch = await buildShelfPatch(adapter, ['f.txt'], []);
      await revertWorkingFiles(adapter, ['f.txt'], []);
      assert.equal(fs.readFileSync(path.join(sb, 'f.txt'), 'utf8'), 'line one\nline two\n', 'reverted to LF base');

      const outcome = await applyPerFile(sb, patch);
      assert.deepEqual(outcome.failed, []);
      assert.deepEqual(outcome.conflicted, []);
      const restored = fs.readFileSync(path.join(sb, 'f.txt'));
      assert.ok(restored.equals(modified), 'byte-identical CRLF restore');
    } finally {
      rmRfRetry(sb);
    }
  });
});
