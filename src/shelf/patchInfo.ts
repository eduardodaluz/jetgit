/**
 * Patch parsing for shelves: extract the file list from a unified diff
 * Buffer (for the Shelves tree) and split a concatenated patch into
 * per-file segments (for apply-per-file fallback when one file conflicts).
 *
 * Operates on Buffers-as-latin1 boundaries only for SPLITTING — segment
 * bytes are re-sliced from the original Buffer so binary ("GIT binary
 * patch") sections survive byte-exact. Parsing never decodes content.
 */

export interface PatchFileEntry {
  /** Path as git reports it (a-side/b-side resolved to the common path). */
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  /** Byte range [start, end) of this file's segment inside the patch. */
  start: number;
  end: number;
}

const DIFF_PREFIX = Buffer.from('diff --git ', 'latin1');

/**
 * Extracts per-file entries with byte ranges. Split points are the byte
 * offsets of each `diff --git ` header; each segment spans from its header
 * to the next header (or EOF).
 */
export function parsePatch(patch: Buffer): PatchFileEntry[] {
  const positions: number[] = [];
  let searchFrom = 0;
  for (;;) {
    const idx = patch.indexOf(DIFF_PREFIX, searchFrom);
    if (idx === -1) {
      break;
    }
    // Header must start at buffer start or after a newline (avoid matching
    // a `diff --git ` inside content).
    if (idx === 0 || patch[idx - 1] === 0x0a) {
      positions.push(idx);
    }
    searchFrom = idx + 1;
  }
  if (positions.length === 0) {
    return [];
  }

  const entries: PatchFileEntry[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i]!;
    const end = i + 1 < positions.length ? positions[i + 1]! : patch.length;
    const segment = patch.subarray(start, end);
    const info = readSegmentHeader(segment.toString('latin1'));
    if (info) {
      entries.push({ ...info, start, end });
    }
  }
  return entries;
}

/** Reads header flags and the file path from one `diff --git` segment. */
function readSegmentHeader(segment: string): { path: string; isNew: boolean; isDeleted: boolean; isBinary: boolean } | undefined {
  const lines = segment.split('\n');
  // `diff --git a/<path> b/<path>` — the a/b paths may be quoted when the
  // filename has special characters (core.quotePath or exotic bytes).
  const header = lines.find((l) => l.startsWith('diff --git '));
  if (!header) {
    return undefined;
  }
  let path = fromDiffGitHeader(header);

  let isNew = false;
  let isDeleted = false;
  let isBinary = false;
  for (const line of lines) {
    if (line.startsWith('new file mode')) {
      isNew = true;
    } else if (line.startsWith('deleted file mode')) {
      isDeleted = true;
    } else if (line.startsWith('GIT binary patch')) {
      isBinary = true;
    } else if (line.startsWith('+++ ') && !isNew) {
      const p = unquotePath(line.slice(4));
      if (p && p !== '/dev/null') {
        path = p;
      }
    } else if (line.startsWith('--- ') && isDeleted) {
      const p = unquotePath(line.slice(4));
      if (p && p !== '/dev/null') {
        path = p;
      }
    }
  }
  return { path: path ?? '', isNew, isDeleted, isBinary };
}

/**
 * Resolves the file path from a `diff --git a/X b/Y` header. Prefers the
 * b-side (matches +++ convention); falls back to the a-side for deletions
 * via the +++/--- refinement in readSegmentHeader.
 */
function fromDiffGitHeader(header: string): string | undefined {
  const rest = header.slice('diff --git '.length).trimEnd();
  // Both sides in one line; split is ambiguous when the path contains
  // spaces, so walk quoted halves first, then fall back to ' b/' split.
  const quoted = /^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) {
    return unquotePath(`"${quoted[2]}"`);
  }
  const mid = rest.indexOf(' b/');
  if (mid !== -1) {
    // +3 skips " b/" — the path content starts right after the slash.
    return unquotePath(rest.slice(mid + 3).trimEnd());
  }
  return unquotePath(rest);
}

/** Strips the conventional a/ or b/ prefix git puts on diff paths. */
function stripABPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function unquotePath(raw: string): string | undefined {
  const trimmed = raw.trimEnd();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // C-style quoting: \t \n \" \\ and \NNN octal escapes are UTF-8 BYTES
    // (git quotes non-ASCII paths this way with core.quotePath). Decode
    // through bytes → UTF-8, never char-by-char latin1.
    const inner = trimmed.slice(1, -1);
    const bytes: number[] = [];
    let i = 0;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1] as string;
        if (next === 't') {
          bytes.push(9);
          i += 2;
          continue;
        }
        if (next === 'n') {
          bytes.push(10);
          i += 2;
          continue;
        }
        if (next === '"') {
          bytes.push(34);
          i += 2;
          continue;
        }
        if (next === '\\') {
          bytes.push(92);
          i += 2;
          continue;
        }
        const octal = inner.slice(i + 1, i + 4);
        if (/^[0-7]{3}$/.test(octal)) {
          bytes.push(parseInt(octal, 8) & 0xff);
          i += 4;
          continue;
        }
        bytes.push(next.charCodeAt(0));
        i += 2;
        continue;
      }
      bytes.push(inner.charCodeAt(i));
      i += 1;
    }
    const decoded = Buffer.from(bytes).toString('utf8');
    return decoded.length > 0 ? stripABPrefix(decoded) : undefined;
  }
  return trimmed.length > 0 ? stripABPrefix(trimmed) : undefined;
}
