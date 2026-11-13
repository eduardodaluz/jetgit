/**
 * Pure merge-conflict probe (M6.8): parsing and planning shared by the merge
 * service and its tests. ZERO imports — no vscode, no node builtins — this
 * module must stay testable in vitest and portable.
 *
 * Sources of truth:
 * - `git status --porcelain=v1 -z` output. Empirical layout (verified on
 *   git 2.56): each record is ONE NUL token, "XY<space>PATH"; renames and
 *   copies (X is R or C) carry the original path as a second bare token.
 *   This is deliberately unlike `diff --name-status -z`, where the status
 *   and the path are separate tokens (see git/nameStatus.ts).
 * - The seven unmerged XY codes git can emit (git-status(1) short format).
 * - IntelliJ-VCS resolution semantics: resolving a conflict IS staging —
 *   checkout the winning side into the worktree, then `git add` collapses
 *   the unmerged index stages to one stage-0 entry; deletions resolve with
 *   `git rm`. No auto-commit: finishing the operation is a separate commit.
 */

export type UnmergedCode = 'DD' | 'AU' | 'UD' | 'UA' | 'DU' | 'AA' | 'UU';

export type MergeOperation = 'merge' | 'cherry-pick' | 'revert' | 'rebase' | 'unknown';

/** One record of `git status --porcelain=v1 -z`. */
export interface PorcelainEntry {
  x: string;
  y: string;
  /** New/current path, repo-relative, forward slashes. */
  path: string;
  /** Renames/copies only: the original path. */
  origPath?: string;
}

const UNMERGED_CODES: ReadonlySet<string> = new Set<string>(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parses `git status --porcelain=v1 -z`. Tokens come from splitting on NUL;
 * empty tokens (the trailing NUL) are skipped and malformed records are
 * dropped, never thrown on — status is best-effort. Untracked ('??') and
 * ignored ('!!') entries parse as regular XY entries so filtering stays in
 * one place (`isUnmerged`).
 */
export function parseStatusPorcelainV1Z(out: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  const tokens = out.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i];
    // Minimal well-formed record: "XY" + space + path (>= 4 chars).
    if (record === undefined || record.length < 4 || record[2] !== ' ') {
      i += 1;
      continue;
    }
    const x = record[0];
    const y = record[1];
    if (x === undefined || y === undefined) {
      i += 1;
      continue;
    }
    const path = record.slice(3);
    if (x === 'R' || x === 'C') {
      const orig = tokens[i + 1];
      entries.push(orig !== undefined && orig.length > 0 ? { x, y, path, origPath: orig } : { x, y, path });
      i += 2;
      continue;
    }
    entries.push({ x, y, path });
    i += 1;
  }
  return entries;
}

/** The unmerged code of an entry, or undefined when it is not unmerged. */
export function unmergedCode(entry: PorcelainEntry): UnmergedCode | undefined {
  const code = `${entry.x}${entry.y}`;
  return UNMERGED_CODES.has(code) ? (code as UnmergedCode) : undefined;
}

export function isUnmerged(entry: PorcelainEntry): boolean {
  return unmergedCode(entry) !== undefined;
}

/** Which git operation file exists under the git dir (MERGE_HEAD and friends). */
export interface OperationFlags {
  mergeHead?: boolean;
  cherryPickHead?: boolean;
  revertHead?: boolean;
  /** The `rebase-merge` directory (interactive/mkdir-style rebase). */
  rebaseMerge?: boolean;
  /** The `rebase-apply` directory (am-style/plain rebase). */
  rebaseApply?: boolean;
}

/** Operation detection precedence: merge > cherry-pick > revert > rebase. */
export function detectOperation(flags: OperationFlags): MergeOperation {
  if (flags.mergeHead) {
    return 'merge';
  }
  if (flags.cherryPickHead) {
    return 'cherry-pick';
  }
  if (flags.revertHead) {
    return 'revert';
  }
  if (flags.rebaseMerge || flags.rebaseApply) {
    return 'rebase';
  }
  return 'unknown';
}

export type ResolveSide = 'ours' | 'theirs';

/**
 * What resolving one unmerged code needs. 'checkout' means "check out the
 * named side's stage into the worktree, then stage" (checkout alone leaves
 * the index unmerged); 'stage' means the winning side is already the
 * worktree/index content — just stage; 'remove' means the file must be
 * deleted from index and worktree (`git rm`).
 */
export type ResolvePlan = { kind: 'checkout'; side: ResolveSide } | { kind: 'stage' } | { kind: 'remove' };

/**
 * The full 7×2 resolution matrix:
 * - UU/AA (both modified/added): either side → checkout + stage.
 * - AU added-by-us: ours → stage-only; theirs → remove.
 * - DU deleted-by-us (added by them): theirs → stage-only; ours → remove.
 * - UD deleted-by-them (modified by us): ours → checkout + stage; theirs → remove.
 * - UA deleted-by-us (added by them): theirs → checkout + stage; ours → remove.
 * - DD both deleted: either side → remove.
 */
export function resolvePlan(code: UnmergedCode, side: ResolveSide): ResolvePlan {
  switch (code) {
    case 'UU':
    case 'AA':
      return { kind: 'checkout', side };
    case 'AU':
      return side === 'ours' ? { kind: 'stage' } : { kind: 'remove' };
    case 'DU':
      return side === 'theirs' ? { kind: 'stage' } : { kind: 'remove' };
    case 'UD':
      return side === 'ours' ? { kind: 'checkout', side: 'ours' } : { kind: 'remove' };
    case 'UA':
      return side === 'theirs' ? { kind: 'checkout', side: 'theirs' } : { kind: 'remove' };
    case 'DD':
      return { kind: 'remove' };
  }
}

export interface ConflictEntry {
  /** Repo-relative path, forward slashes (the porcelain path). */
  path: string;
  code: UnmergedCode;
}

export interface MergeSnapshot {
  operation: MergeOperation;
  conflicts: ConflictEntry[];
}

/** Builds the snapshot from operation flags and raw `status --porcelain=v1 -z` output. */
export function buildSnapshot(flags: OperationFlags, statusOut: string): MergeSnapshot {
  const conflicts: ConflictEntry[] = [];
  for (const entry of parseStatusPorcelainV1Z(statusOut)) {
    const code = unmergedCode(entry);
    if (code !== undefined) {
      conflicts.push({ path: entry.path, code });
    }
  }
  return { operation: detectOperation(flags), conflicts };
}
