/**
 * Shelf patch construction and revert, isolated behind a minimal git adapter
 * so integration tests exercise the EXACT same command sequences as the
 * service (no drift between tested and shipped behavior).
 */
import { PathspecFile, pathspecArgs } from '../git/gitCli';

export interface GitDiffAdapter {
  cwd(): string;
  /** Read-only git run returning stdout or throwing on failure. */
  runReadOnlyChecked(args: string[]): Promise<Buffer>;
  /** Read-only git run returning the full result (no exit-code checking). */
  runReadOnly(args: string[]): Promise<{ stdout: Buffer; stderr: string; code: number }>;
  runChecked(args: string[]): Promise<Buffer>;
}

export function literalPathspec(p: string): string {
  return `:(literal)${p.replace(/\\/g, '/')}`;
}

/**
 * Builds the shelf patch Buffer:
 *  - tracked members (incl. deletions, staged+unstaged): `git diff HEAD
 *    --binary` segments via :(literal) pathspec argv. NOTE: git diff does
 *    NOT support --pathspec-from-file (unlike add/checkout/commit), so
 *    paths travel as argv in chunks to stay under Windows argv limits;
 *  - each untracked member: one `git diff --binary --no-index` segment with
 *    a repo-relative path so `git apply` lands it later. `--no-index` exits
 *    1 when differences exist — that is success here.
 */
export async function buildShelfPatch(adapter: GitDiffAdapter, tracked: string[], untracked: string[]): Promise<Buffer> {
  const segments: Buffer[] = [];

  const CHUNK = 100; // paths per invocation — comfortably under the 32k argv limit
  for (let i = 0; i < tracked.length; i += CHUNK) {
    const chunk = tracked.slice(i, i + CHUNK).map(literalPathspec);
    const stdout = await adapter.runReadOnlyChecked(['diff', 'HEAD', '--binary', '--no-color', '--', ...chunk]);
    segments.push(stdout);
  }
  for (const rel of untracked) {
    const relFwd = rel.replace(/\\/g, '/');
    const result = await adapter.runReadOnly(['diff', '--binary', '--no-index', '--', '/dev/null', relFwd]);
    if (result.stdout.length > 0) {
      segments.push(result.stdout);
    } else if (result.code !== 0 && result.code !== 1) {
      throw new Error(`git diff --no-index failed for ${rel}: ${result.stderr}`);
    }
  }
  return Buffer.concat(segments);
}

/**
 * Reverts working files after shelving: tracked → index version (preserves
 * staged state), untracked → removed (git clean). IntelliJ "Shelve"
 * semantics; "Save to Shelf" skips this entirely.
 */
export async function revertWorkingFiles(adapter: GitDiffAdapter, tracked: string[], untracked: string[]): Promise<void> {
  if (tracked.length > 0) {
    await withLiteralPathspecFile(tracked, (ps) =>
      adapter.runChecked(['checkout', '--pathspec-from-file=' + ps.path.replace(/\\/g, '/'), '--pathspec-file-nul']),
    );
  }
  if (untracked.length > 0) {
    await adapter.runChecked(['clean', '-f', '--', ...untracked.map(literalPathspec)]);
  }
}

async function withLiteralPathspecFile<T>(paths: string[], fn: (ps: PathspecFile) => Promise<T>): Promise<T> {
  const ps = await PathspecFile.create(paths.map(literalPathspec));
  try {
    return await fn(ps);
  } finally {
    await ps.dispose();
  }
}

// Re-exported so callers (service, tests) share one NUL-pathspec discipline.
export { pathspecArgs };
