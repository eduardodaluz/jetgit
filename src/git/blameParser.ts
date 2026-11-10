/**
 * Parser for `git blame --porcelain` output. Pure functions — no git exec.
 *
 * Porcelain layout (per commit, first occurrence is the full header; later
 * occurrences of the same commit appear as bare `<sha> <orig-line>
 * <final-line> <count>` lines):
 *   <sha> <orig-line> <final-line> <num-lines>
 *   author <name>
 *   author-mail <email>
 *   author-time <unix-seconds>
 *   author-tz <tz>
 *   summary <subject>
 *   [previous <sha> <file>]
 *   [boundary]
 *   filename <file>
 *   \t<line content>
 */

export interface BlameCommit {
  sha: string;
  author: string;
  email: string;
  /** Author time, unix seconds. */
  timeSeconds: number;
  summary: string;
  /** Previous commit that touched this region before this one (rename-aware). */
  previousSha?: string;
  /** True for commits outside the current branch history (`boundary`). */
  boundary: boolean;
}

export interface BlameResult {
  /** final line number (1-based) → commit sha */
  lineToSha: Map<number, string>;
  commits: Map<string, BlameCommit>;
}

export function parseGitBlame(stdout: Buffer | string): BlameResult {
  const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
  const lineToSha = new Map<number, string>();
  const commits = new Map<string, BlameCommit>();

  let currentSha: string | undefined;
  let pending: Partial<BlameCommit> | undefined;
  let headerSeen = false;

  const flush = (): void => {
    if (currentSha && pending) {
      const existing = commits.get(currentSha);
      if (!existing) {
        commits.set(currentSha, {
          sha: currentSha,
          author: pending.author ?? '',
          email: pending.email ?? '',
          timeSeconds: pending.timeSeconds ?? 0,
          summary: pending.summary ?? '',
          previousSha: pending.previousSha,
          boundary: pending.boundary ?? false,
        });
      }
    }
    pending = undefined;
    headerSeen = false;
  };

  for (const rawLine of text.split('\n')) {
    // Normalize CRLF: porcelain output on Windows-checked repos ends lines with \r.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('\t')) {
      // Content line — marks the end of a commit header block.
      flush();
      continue;
    }

    const shaMatch = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (shaMatch) {
      const sha = shaMatch[1];
      if (!sha) {
        continue;
      }
      currentSha = sha;
      lineToSha.set(Number(shaMatch[3]), sha);
      if (commits.has(sha)) {
        // Bare reference (no header follows) — only the line mapping matters.
        pending = undefined;
        headerSeen = false;
      } else {
        pending = {};
        headerSeen = true;
      }
      continue;
    }
    if (!headerSeen || !pending) {
      continue;
    }

    if (line.startsWith('author ')) {
      pending.author = line.slice('author '.length);
    } else if (line.startsWith('author-mail ')) {
      pending.email = line.slice('author-mail '.length).replace(/^<|>$/g, '');
    } else if (line.startsWith('author-time ')) {
      pending.timeSeconds = Number(line.slice('author-time '.length)) || 0;
    } else if (line.startsWith('summary ')) {
      pending.summary = line.slice('summary '.length);
    } else if (line.startsWith('previous ')) {
      pending.previousSha = line.slice('previous '.length).split(' ')[0];
    } else if (line === 'boundary') {
      pending.boundary = true;
    } else if (line.startsWith('filename ')) {
      // Last header field — the block ends on the next content line anyway.
    }
  }
  flush();

  return { lineToSha, commits };
}

/** Uncommitted working-tree lines report the all-zero sha. */
export const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';
