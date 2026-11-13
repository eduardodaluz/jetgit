/**
 * Partial commit via a temporary index (M6.7): commits EXACTLY the included
 * content per file — whole files as-is, partial files as "HEAD content for
 * the excluded hunks restored" — without touching the worktree or the user's
 * real index until after a successful commit.
 *
 * Mechanism: GIT_INDEX_FILE points at a throwaway index; read-tree HEAD
 * (read-tree --empty on a headless repo), then per file hash-object -w
 * (--path=<relPath> so .gitattributes/clean filters see the REAL path —
 * critical for CRLF) + update-index --cacheinfo, then `git commit` runs
 * against the temp index. Hooks run with the temp index inherited — they see
 * exactly what is being committed. On success the real index is synced with
 * one `git reset -q` over the placed paths (index := HEAD), which produces
 * the standard post-`add -p` status: committed files clean, remainder
 * unstaged. Any failure before that reset is atomic — refs and the real
 * index were never mutated.
 *
 * The `--only` path in changelists/service.ts stays for whole-file commits
 * (M2 semantics, tested); any partial member switches the whole commit here.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { refContent } from '../blame/blameQuery';
import { ensureTmp, GitCli, TempBufferFile, TempTextFile, withPathspecFiles, pathspecArgs } from '../git/gitCli';
import { literalPathspec } from '../shelf/patchBuilder';
import {
  assembleIncludedLf,
  parseHunks,
  restoreEol,
  toLf,
  type DiffHunk,
  type RollbackAdapter,
} from './rollbackQuery';

const fwd = (p: string): string => p.replace(/\\/g, '/');

/** Structural subset of RepoHandle so integration tests can build fakes. */
export interface PartialCommitRepo {
  readonly rootUri: vscode.Uri;
  readonly cli: GitCli;
}

/** relPath → the hunk signatures included in the commit. */
export type PartialPlan = ReadonlyMap<string, ReadonlySet<string>>;

export interface PartialCommitResult {
  /** Paths committed with content (whole or partial). */
  placed: string[];
  /** Tracked paths committed as deletions. */
  deleted: string[];
  /** Partial paths whose pre-existing staged delta was consumed by the sync. */
  consumedStaged: string[];
  /** Partial paths whose signatures no longer matched the fresh diff (skipped). */
  stale: string[];
}

function adapterFor(repo: PartialCommitRepo): RollbackAdapter {
  return {
    cwd: () => repo.rootUri.fsPath,
    runReadOnly: async (args) => repo.cli.runReadOnly(repo.rootUri.fsPath, args),
  };
}

/** Moves to a temp file the diff the review pipeline is built on (exit 1 = differences). */
export async function diffWorktreeVsHead(adapter: RollbackAdapter, headBytes: Buffer, bufferText: string): Promise<DiffHunk[]> {
  const a = await TempBufferFile.create(Buffer.from(toLf(headBytes.toString('utf8')), 'utf8'));
  const b = await TempBufferFile.create(Buffer.from(toLf(bufferText), 'utf8'));
  try {
    const result = await adapter.runReadOnly(['diff', '--no-index', '--no-color', '-U0', '--', fwd(a.path), fwd(b.path)]);
    if (result.code === 0) {
      return [];
    }
    if (result.code === 1) {
      return parseHunks(result.stdout.toString('utf8'));
    }
    const firstLine = result.stderr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)[0] ?? `exit code ${result.code}`;
    throw new Error(`git diff --no-index failed: ${firstLine}`);
  } finally {
    await a.dispose();
    await b.dispose();
  }
}

interface IndexEntry {
  mode: string;
  sha: string;
}

/** `git ls-files -s` for one path — real-index mode+sha, or undefined when untracked. */
async function lsFilesEntry(repo: PartialCommitRepo, rel: string): Promise<IndexEntry | undefined> {
  const result = await repo.cli.runReadOnly(repo.rootUri.fsPath, ['ls-files', '-s', '-z', '--', literalPathspec(rel)]);
  const match = /^(\d{6}) ([0-9a-f]{40}) \d/.exec(result.stdout.toString('utf8'));
  return match ? { mode: match[1]!, sha: match[2]! } : undefined;
}

/** HEAD blob shas for a path batch (empty map on headless repos). */
async function headShasFor(repo: PartialCommitRepo, rels: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const CHUNK = 100;
  for (let i = 0; i < rels.length; i += CHUNK) {
    const chunk = rels.slice(i, i + CHUNK).map(literalPathspec);
    const result = await repo.cli.runReadOnly(repo.rootUri.fsPath, ['ls-tree', 'HEAD', '-z', '--', ...chunk]);
    for (const entry of result.stdout.toString('utf8').split('\0')) {
      const match = /^\d{6} \w+ ([0-9a-f]{40})\t(.+)$/.exec(entry);
      if (match) {
        out.set(match[2]!, match[1]!);
      }
    }
  }
  return out;
}

async function platformDefaultMode(abs: string): Promise<string> {
  if (process.platform === 'win32') {
    return '100644'; // exec bit is not expressible (core.filemode=false on Windows)
  }
  try {
    const stat = await fsp.lstat(abs);
    if (stat.isSymbolicLink()) {
      return '120000';
    }
    return stat.mode & 0o111 ? '100755' : '100644';
  } catch {
    return '100644';
  }
}

/**
 * Commits exactly `members` through the temp index. Returns the outcome;
 * an empty placed+deleted result means nothing joined (caller shows the
 * standard "no changes" info). Throws on failure — the caller maps errors;
 * nothing was mutated when that happens.
 */
export async function commitPartial(repo: PartialCommitRepo, members: readonly string[], partial: PartialPlan, message: string): Promise<PartialCommitResult> {
  const cwd = repo.rootUri.fsPath;
  ensureTmp();
  const tmpIndex = path.join(os.tmpdir(), `jetgit-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const indexEnv: Record<string, string> = { GIT_INDEX_FILE: fwd(tmpIndex) };
  const tempFiles: TempBufferFile[] = [];
  const placed: string[] = [];
  const deleted: string[] = [];
  const consumedStaged: string[] = [];
  try {
    const headProbe = await repo.cli.run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const hasHead = headProbe.code === 0;
    await repo.cli.runChecked(cwd, hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env: indexEnv });

    const adapter = adapterFor(repo);
    const headShas = hasHead ? await headShasFor(repo, members) : new Map<string, string>();
    const stale: string[] = [];

    for (const rel of members) {
      const abs = path.join(cwd, ...rel.split('/'));
      let disk: Buffer;
      try {
        disk = await fsp.readFile(abs);
      } catch {
        // Locally deleted tracked member — whole-file deletion (partial
        // un-deletion is structurally impossible: the right pane is empty).
        // update-index takes PLAIN repo-relative paths — pathspec magic
        // (`:(literal)…`) is silently IGNORED here (found empirically).
        await repo.cli.runChecked(cwd, ['update-index', '--force-remove', '--', fwd(rel)], { env: indexEnv });
        deleted.push(rel);
        continue;
      }

      const partialSigs = partial.get(rel);
      let contentBytes = disk;
      if (partialSigs && partialSigs.size > 0) {
        const headBytes = await refContent(adapter, 'HEAD', rel);
        if (!headBytes) {
          // Untracked file — no HEAD side, so the partial plan is inert: whole.
        } else {
          const headLf = toLf(headBytes.toString('utf8'));
          const diskLf = toLf(disk.toString('utf8'));
          const hunks = await diffWorktreeVsHead(adapter, headBytes, disk.toString('utf8'));
          const assembled = assembleIncludedLf(headLf, diskLf, hunks, partialSigs);
          if (assembled.contentLf === undefined) {
            // Stale signatures or the included hunks net to HEAD: skip the file.
            if (assembled.matched === 0) {
              stale.push(rel);
            }
            continue;
          }
          contentBytes = restoreEol(assembled.contentLf, disk);
        }
      }

      const tmp = await TempBufferFile.create(contentBytes);
      tempFiles.push(tmp);
      const hashOut = await repo.cli.runChecked(cwd, ['hash-object', '-w', `--path=${rel}`, '--', fwd(tmp.path)], { env: indexEnv });
      const sha = hashOut.toString('utf8').trim();
      const indexEntry = await lsFilesEntry(repo, rel);
      const mode = indexEntry?.mode ?? (await platformDefaultMode(abs));
      await repo.cli.runChecked(cwd, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`], { env: indexEnv });
      placed.push(rel);

      // E.3: a partial file whose real index carried a staged delta loses it
      // in the post-commit sync — surface it instead of silently consuming.
      if (partialSigs && partialSigs.size > 0 && indexEntry && indexEntry.sha !== headShas.get(rel)) {
        consumedStaged.push(rel);
      }
    }

    if (placed.length === 0 && deleted.length === 0) {
      return { placed, deleted, consumedStaged, stale };
    }

    const msgFile = await TempTextFile.create(message);
    try {
      await repo.cli.runChecked(cwd, ['commit', `--file=${msgFile.path}`], { env: indexEnv });
    } finally {
      await msgFile.dispose();
    }

    // Success: real index := HEAD for the committed paths (worktree untouched).
    await withPathspecFiles([[...placed, ...deleted]], (ps) => repo.cli.runChecked(cwd, ['reset', '-q', ...pathspecArgs(ps)]));
    return { placed, deleted, consumedStaged, stale };
  } finally {
    for (const tmp of tempFiles) {
      await tmp.dispose();
    }
    await fsp.rm(tmpIndex, { force: true });
  }
}
