/**
 * Shared parser for `git diff --name-status -z` output (used by blame's
 * commit file listing and M6 branch compare). `-z` makes paths
 * NUL-delimited — tabs, spaces and newlines in names survive intact, and
 * `core.quotepath=false` (always set by GitCli) keeps unicode names raw.
 * R/C records carry the old path after the status token, so they consume
 * three tokens; A/M/D/T consume two.
 */

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface CommitFile {
  /** Path as of the newer side of the diff (rename target). */
  path: string;
  /** For renames/copies, the pre-image path. */
  oldPath?: string;
  status: FileStatus;
}

export function parseNameStatus(out: string): CommitFile[] {
  const files: CommitFile[] = [];
  const tokens = out.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i];
    if (statusToken === undefined || statusToken.length === 0) {
      i += 1;
      continue;
    }
    const letter = statusToken[0] as FileStatus;
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath !== undefined && newPath !== undefined) {
        files.push({ path: newPath, oldPath, status: letter });
      }
      i += 3;
      continue;
    }
    const p = tokens[i + 1];
    if (p !== undefined && (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'T')) {
      files.push({ path: p, status: letter });
    }
    i += 2;
  }
  return files;
}
