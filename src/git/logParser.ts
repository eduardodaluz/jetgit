/**
 * Parser for `git log` output with %x1f (unit-separator) field and
 * %x1e (record-separator) record delimiters. Pure functions, no git exec —
 * the caller composes the format string and runs the CLI.
 */

export interface CommitInfo {
  /** Full 40-char hash. */
  hash: string;
  /** Abbreviated hash. */
  shortHash: string;
  authorName: string;
  authorEmail: string;
  /** Author date, unix seconds. */
  authorDateSeconds: number;
  subject: string;
  body: string;
  parentHashes: string[];
}

export const LOG_FORMAT = '%x1e%x1f%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1f%P%x1e';
const RECORD_SEP = '\u001e';
const FIELD_SEP = '\u001f';

export function parseGitLog(stdout: Buffer | string): CommitInfo[] {
  const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
  const commits: CommitInfo[] = [];
  for (const record of text.split(RECORD_SEP)) {
    if (record.length === 0) {
      continue;
    }
    const fields = record.split(FIELD_SEP);
    // Fields: '' (leading), H, h, an, ae, at, s, b, P
    const hash = fields[1];
    if (!hash) {
      continue;
    }
    commits.push({
      hash,
      shortHash: fields[2] ?? hash.slice(0, 7),
      authorName: fields[3] ?? '',
      authorEmail: fields[4] ?? '',
      authorDateSeconds: Number(fields[5] ?? 0) || 0,
      subject: fields[6] ?? '',
      body: fields[7] ?? '',
      parentHashes: (fields[8] ?? '').split(' ').filter((p) => p.length > 0),
    });
  }
  return commits;
}
