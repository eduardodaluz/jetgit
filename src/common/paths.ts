/**
 * Path normalization rules for JetGit state. Pure functions — no vscode/node
 * imports so they stay trivially testable.
 *
 * Contract:
 * - State files store repo-relative paths with '/' separators, original case
 *   preserved in VALUES.
 * - MAP KEYS are case-folded on win32 (NTFS is case-insensitive); lookups and
 *   dedupe always go through `keyFor`, never raw string equality.
 */

const isWin32 = typeof process !== 'undefined' && process.platform === 'win32';

/** Normalizes separators to '/' and strips trailing slashes. */
export function normalizeRel(p: string): string {
  const unified = p.replace(/\\/g, '/');
  return unified.endsWith('/') && unified.length > 1 ? unified.slice(0, -1) : unified;
}

/** Map key for a repo-relative path: case-folded on win32. */
export function keyFor(relPath: string): string {
  const normalized = normalizeRel(relPath);
  return isWin32 ? normalized.toLowerCase() : normalized;
}

/**
 * Map key for an ABSOLUTE path (Local History): separators normalized,
 * case-folded on win32 (NTFS is case-insensitive). Not filesystem-safe —
 * hash it (sha1) before using as a directory name.
 */
export function keyForAbs(absPath: string): string {
  const normalized = normalizeRel(absPath);
  return isWin32 ? normalized.toLowerCase() : normalized;
}

/**
 * Repo-relative path from an absolute path. Returns undefined when the path
 * is not inside the root. Accepts both separator styles on input.
 */
export function toRepoRel(absPath: string, repoRoot: string): string | undefined {
  const normAbs = normalizeRel(absPath);
  const normRoot = normalizeRel(repoRoot);
  const rootWithSep = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
  if (!normAbs.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
    return undefined;
  }
  const rel = normAbs.slice(rootWithSep.length);
  return rel.length > 0 ? rel : undefined;
}

/** Absolute path from a repo-relative path (original case preserved in `relPath`). */
export function fromRepoRel(relPath: string, repoRoot: string): string {
  const root = normalizeRel(repoRoot);
  return `${root}/${normalizeRel(relPath)}`;
}

/** Case-insensitive-safe set membership for rel paths. */
export class PathSet {
  private readonly map = new Map<string, string>();

  add(relPath: string): void {
    this.map.set(keyFor(relPath), normalizeRel(relPath));
  }

  has(relPath: string): boolean {
    return this.map.has(keyFor(relPath));
  }

  delete(relPath: string): boolean {
    return this.map.delete(keyFor(relPath));
  }

  /** Original-case values, insertion-ordered. */
  values(): string[] {
    return [...this.map.values()];
  }

  get size(): number {
    return this.map.size;
  }
}
