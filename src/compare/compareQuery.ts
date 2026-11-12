/**
 * Branch-compare queries over the same thin adapter blame uses (cwd +
 * read-only git exec). Pure logic, no vscode — the tree/commands modules
 * carry the UI, and the M6 acceptance check (in/out counts must equal
 * `git log --left-right --count`) runs against these functions directly.
 */
import type { BlameAdapter } from '../blame/blameQuery';
import { LOG_FORMAT, parseGitLog, type CommitInfo } from '../git/logParser';
import { parseNameStatus, type CommitFile } from '../git/nameStatus';

export type { CommitInfo } from '../git/logParser';

const REF_TYPE_HEAD = 1;
const REF_TYPE_REMOTE_HEAD = 2;
const REF_TYPE_TAG = 3;

export interface RefGroups {
  branches: string[];
  remotes: string[];
  tags: string[];
}

/** Groups + sorts refs for the compare picker (HEAD pseudo-ref excluded). */
export function groupRefs(refs: ReadonlyArray<{ type: number; name?: string; remote?: string }>): RefGroups {
  const groups: RefGroups = { branches: [], remotes: [], tags: [] };
  for (const ref of refs) {
    const name = ref.name;
    if (!name || name === 'HEAD') {
      continue;
    }
    if (ref.type === REF_TYPE_HEAD) {
      groups.branches.push(name);
    } else if (ref.type === REF_TYPE_REMOTE_HEAD) {
      // vscode.git names remote refs 'origin/main' on some builds and short
      // names + `remote` on others — normalize to the full form either way.
      groups.remotes.push(ref.remote && !name.startsWith(ref.remote + '/') ? `${ref.remote}/${name}` : name);
    } else if (ref.type === REF_TYPE_TAG) {
      groups.tags.push(name);
    }
  }
  const sort = (list: string[]): string[] => [...list].sort((a, b) => a.localeCompare(b));
  return { branches: sort(groups.branches), remotes: sort(groups.remotes), tags: sort(groups.tags) };
}

export interface CompareCounts {
  /** Commits on HEAD's side of the symmetry range (left). */
  outgoing: number;
  /** Commits on the ref's side of the symmetry range (right). */
  incoming: number;
}

function check(result: { stdout: Buffer; stderr: string; code: number }, args: string[]): Buffer {
  if (result.code !== 0) {
    const firstLine = result.stderr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)[0] ?? `exit code ${result.code}`;
    throw new Error(`git ${args[0]} failed: ${firstLine}`);
  }
  return result.stdout;
}

/** `git rev-list --left-right --count HEAD...ref` stdout → { outgoing, incoming }. */
export function parseLeftRightCount(stdout: Buffer | string): CompareCounts {
  const out = (typeof stdout === 'string' ? stdout : stdout.toString('utf8')).trim();
  const parts = out.split(/\s+/).map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`git rev-list --left-right --count produced unexpected output: ${out}`);
  }
  return { outgoing: parts[0] ?? 0, incoming: parts[1] ?? 0 };
}

/**
 * Exact in/out counts via rev-list. `git log --count` is silently IGNORED
 * by log on current git (it prints the whole history) — rev-list is the
 * only correct command for the left/right pair.
 */
export async function compareCounts(adapter: BlameAdapter, ref: string): Promise<CompareCounts> {
  const args = ['rev-list', '--left-right', '--count', `HEAD...${ref}`];
  return parseLeftRightCount(check(await adapter.runReadOnly(args), args));
}

/**
 * Commit list for one direction, capped at maxEntries (counts stay exact —
 * the tree shows "+N more" when the list is capped).
 */
export async function listCommits(adapter: BlameAdapter, range: string, maxEntries: number): Promise<CommitInfo[]> {
  const args = ['log', `--max-count=${maxEntries}`, `--format=${LOG_FORMAT}`, range];
  return parseGitLog(check(await adapter.runReadOnly(args), args));
}

export type CompareClass = 'local' | 'ref' | 'diff';

export interface CompareFile extends CommitFile {
  /** local = only on our side (green); ref = only at the ref (gray); diff = both sides differ (blue). */
  cls: CompareClass;
}

/** IntelliJ parity: green / gray / blue file classes, from the diff direction. */
export function classify(status: CommitFile['status']): CompareClass {
  switch (status) {
    case 'A':
      return 'local';
    case 'D':
      return 'ref';
    default:
      return 'diff';
  }
}

/**
 * File matrix `ref → HEAD|worktree`. Committed mode diffs the two tips
 * (uncommitted work invisible); worktree mode diffs the ref against the
 * tracked working tree (untracked files are invisible — git diff semantics).
 */
export async function compareFiles(adapter: BlameAdapter, ref: string, mode: 'committed' | 'worktree'): Promise<CompareFile[]> {
  const args = mode === 'committed' ? ['diff', '--name-status', '-z', '-M', ref, 'HEAD'] : ['diff', '--name-status', '-z', '-M', ref];
  const out = check(await adapter.runReadOnly(args), args).toString('utf8');
  return parseNameStatus(out).map((f) => ({ ...f, cls: classify(f.status) }));
}
