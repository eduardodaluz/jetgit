/**
 * Blame/commit queries over a thin adapter, mirroring shelf/patchBuilder's
 * GitDiffAdapter pattern: the production adapter wraps GitApiService+GitCli,
 * tests wrap a real sandbox repo through execFileSync. Pure logic, no vscode.
 */
import { parseGitBlame, type BlameResult } from '../git/blameParser';
import { parseNameStatus, type CommitFile } from '../git/nameStatus';

export interface GitCliResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number;
}

export interface BlameAdapter {
  /** Repository working-tree root (absolute path). */
  cwd(): string;
  runReadOnly(args: string[]): Promise<GitCliResult>;
}

export interface BlameQueryOptions {
  ignoreWhitespace: boolean;
}

function check(result: GitCliResult, args: string[]): Buffer {
  if (result.code !== 0) {
    const firstLine = result.stderr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)[0] ?? `exit code ${result.code}`;
    throw new Error(`git ${args[0]} failed: ${firstLine}`);
  }
  return result.stdout;
}

/** Blame for a single line (`-L n,n` — cheap even on huge files). */
export async function blameLine(adapter: BlameAdapter, relPath: string, line: number, opts: BlameQueryOptions): Promise<BlameResult> {
  const args = ['blame', '--porcelain'];
  if (opts.ignoreWhitespace) {
    args.push('-w');
  }
  args.push('-L', `${line},${line}`, '--', relPath);
  return parseGitBlame(check(await adapter.runReadOnly(args), args));
}

/** Whole-file blame (one invocation; caller is responsible for size caps). */
export async function blameFile(adapter: BlameAdapter, relPath: string, opts: BlameQueryOptions): Promise<BlameResult> {
  const args = ['blame', '--porcelain'];
  if (opts.ignoreWhitespace) {
    args.push('-w');
  }
  args.push('--', relPath);
  return parseGitBlame(check(await adapter.runReadOnly(args), args));
}

/** Full commit message body (subject + wrapped paragraphs). */
export async function commitBody(adapter: BlameAdapter, sha: string): Promise<string> {
  return check(await adapter.runReadOnly(['log', '-1', '--format=%B', sha]), ['log']).toString('utf8');
}

export interface CommitInfo {
  sha: string;
  author: string;
  timeSeconds: number;
  summary: string;
}

/** One commit's display fields. */
export async function commitInfo(adapter: BlameAdapter, sha: string): Promise<CommitInfo | undefined> {
  const out = check(await adapter.runReadOnly(['log', '-1', '--format=%H%x1f%an%x1f%at%x1f%s', sha]), ['log']).toString('utf8').trimEnd();
  const parts = out.split('\x1f');
  const [shaField, author, time, summary] = parts;
  if (!shaField) {
    return undefined;
  }
  return { sha: shaField, author: author ?? '', timeSeconds: Number(time) || 0, summary: summary ?? '' };
}

export type { CommitFile };

/**
 * Files touched by a commit. `-z` for NUL-safe parsing (tab/newline paths),
 * `--root` so the initial commit lists its files instead of empty output.
 * Token parsing lives in git/nameStatus (shared with M6 compare).
 */
export async function commitFiles(adapter: BlameAdapter, sha: string): Promise<CommitFile[]> {
  const out = check(
    await adapter.runReadOnly(['diff-tree', '--root', '-r', '-z', '--name-status', '--no-commit-id', '-M', sha]),
    ['diff-tree'],
  ).toString('utf8');
  return parseNameStatus(out);
}

/** `git show <ref>:<relPath>` — undefined when the ref/path pair doesn't resolve. */
export async function refContent(adapter: BlameAdapter, ref: string, relPath: string): Promise<Buffer | undefined> {
  const result = await adapter.runReadOnly(['show', `${ref}:${relPath}`]);
  if (result.code !== 0) {
    return undefined;
  }
  return result.stdout;
}
