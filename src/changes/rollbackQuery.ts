/**
 * Partial rollback of uncommitted changes (M6.5): parse the -U0 diff between
 * HEAD content and the LIVE buffer text and turn the selected hunks into line
 * edits that restore the HEAD-side content. Base is always HEAD, never the
 * index — the diff the user is looking at is HEAD vs working tree, and a
 * vs-index rollback would silently no-op on a fully staged file.
 *
 * Pure logic, no vscode import (vitest rule). The command layer owns the git
 * invocation (`git diff --no-index` over two temp files — HEAD bytes vs
 * normalized buffer text, so line numbers match the buffer even when
 * unsaved) and converts LineEdits into a WorkspaceEdit.
 *
 * Everything works in LF space: callers normalize both sides with toLf(),
 * and the command layer re-applies the document EOL when building TextEdits.
 */

export interface GitCliResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number;
}

export interface RollbackAdapter {
  /** Repository working-tree root (absolute path). */
  cwd(): string;
  runReadOnly(args: string[]): Promise<GitCliResult>;
}

export interface DiffHunk {
  /** 1-based; for count 0 the number is the line BEFORE the gap (GNU convention). */
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** '-'-side content lines, no EOLs. */
  oldLines: string[];
  /** '+'-side content lines, no EOLs. */
  newLines: string[];
}

/** Normalizes CRLF to LF (never lone \r — mixed-EOL documents are a documented limitation). */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Splits into content lines, dropping the phantom '' after a final \n ('' → []). */
export function splitLfLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

// No '$' anchor: git appends the function-context string after the second '@@'.
// Absent ',n' means count 1 (unified diff elides only ',1'; 0 is always explicit).
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses `git diff --no-index --no-color -U0` stdout. Empty/undiffable → [].
 * `\ No newline at end of file` markers are SKIPPED: EOF semantics derive
 * from the texts themselves (see computeRollbackEdits), not from the marker.
 */
export function parseHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;

  const close = (): void => {
    if (current) {
      // Drop impossible hunks (parse drift) — never apply a wrong edit.
      if (current.oldLines.length === current.oldCount && current.newLines.length === current.newCount) {
        hunks.push(current);
      }
      current = undefined;
    }
  };

  for (const line of diffText.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      close();
      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);
      if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) {
        continue;
      }
      current = {
        oldStart,
        oldCount: header[2] !== undefined ? Number(header[2]) : 1,
        newStart,
        newCount: header[4] !== undefined ? Number(header[4]) : 1,
        oldLines: [],
        newLines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('+')) {
      current.newLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      current.oldLines.push(line.slice(1));
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — ignored on purpose.
    } else if (!line.startsWith(' ')) {
      // A non-body line (file header, EOF) closes the hunk.
      close();
    }
    // ' ' context lines cannot occur with -U0; tolerated as no-ops.
  }
  close();
  return hunks;
}

/** Inclusive, 0-based line range. */
export interface LineSelection {
  first: number;
  last: number;
}

export type SelectionSpace = 'old' | 'new';

/**
 * One rollback edit in BUFFER (new-space) coordinates. `text` is the exact
 * LF replacement for the region — endLineExclusive === startLine means an
 * insertion before that line (text carries its own trailing '\n').
 */
export interface LineEdit {
  startLine: number;
  endLineExclusive: number;
  text: string;
  /**
   * The region extends to the true end of the document; the command layer
   * must anchor the range at document end (positionAt(text length)) so
   * final-newline transitions round-trip exactly.
   */
  touchesDocumentEnd: boolean;
}

function overlaps(first: number, last: number, start: number, endExclusive: number): boolean {
  return start < last + 1 && endExclusive > first;
}

/**
 * Computes the rollback edits for the hunks intersecting `selections`
 * (null ⇒ every hunk, i.e. full rollback). Edits are ascending and
 * disjoint — git hunks never overlap — so one WorkspaceEdit carries them
 * all against the same document snapshot.
 *
 * EOF handling: the LAST edit whose region reaches the document end gets
 * `touchesDocumentEnd` and its text becomes `headLf.slice(prefixLength)` —
 * the exact head-side remainder. That one rule makes all four trailing
 * newline transitions (added/removed, in both directions) round-trip
 * byte-exactly, and it covers restore-at-EOF for deletion hunks.
 */
export function computeRollbackEdits(
  headLf: string,
  bufferLf: string,
  hunks: readonly DiffHunk[],
  selections: readonly LineSelection[] | null,
  space: SelectionSpace,
): LineEdit[] {
  const bufferLines = splitLfLines(bufferLf);
  const selected = hunks.filter((h) => {
    if (!selections) {
      return true;
    }
    return selections.some((sel) => {
      if (space === 'new') {
        // Footprint [newStart-1, newStart-1+newCount). A pure deletion leaves
        // no selectable buffer lines; it is reachable through the line just
        // before the gap ([newStart-1, newStart)) or via old-space selection.
        const start = h.newStart - 1;
        const endExclusive = h.newCount > 0 ? start + h.newCount : start + 1;
        return overlaps(sel.first, sel.last, Math.max(start, 0), endExclusive);
      }
      // Old space: pure additions have no old lines to select.
      const start = Math.max(h.oldStart - 1, 0);
      const endExclusive = h.oldStart - 1 + h.oldCount;
      return h.oldCount > 0 && overlaps(sel.first, sel.last, start, endExclusive);
    });
  });

  const edits: LineEdit[] = [];
  // Region text: the region spans whole lines (each contributes its newline),
  // so the replacement carries a trailing '\n' — EXCEPT the EOF edit, whose
  // text comes from the headLf slice below and carries the exact head ending.
  for (const h of selected) {
    const replacement = h.oldLines.length > 0 ? h.oldLines.join('\n') + '\n' : '';
    if (h.newCount === 0) {
      // Restoring deleted lines: insert before 0-based line newStart
      // (the gap sits after 1-based line newStart). newStart === length ⇒ EOF.
      const at = h.newStart;
      if (at < 0 || at > bufferLines.length) {
        continue;
      }
      edits.push({ startLine: at, endLineExclusive: at, text: replacement, touchesDocumentEnd: false });
    } else {
      const start = h.newStart - 1;
      const endExclusive = start + h.newCount;
      if (start < 0 || endExclusive > bufferLines.length) {
        continue; // stale hunk — the file changed under us
      }
      edits.push({ startLine: start, endLineExclusive: endExclusive, text: replacement, touchesDocumentEnd: false });
    }
  }

  const last = edits[edits.length - 1];
  if (last) {
    const reachesEnd =
      last.endLineExclusive > last.startLine
        ? last.endLineExclusive >= bufferLines.length
        : last.startLine >= bufferLines.length;
    if (reachesEnd) {
      // Prefix = the first startLine buffer lines, each followed by '\n'
      // (when startLine === length the prefix is the entire buffer, trailing
      // newline included). headLf minus that prefix is exactly the region's
      // desired content, final-newline state included.
      let prefixLength = 0;
      if (last.startLine >= bufferLines.length) {
        prefixLength = bufferLf.length;
      } else {
        for (let i = 0; i < last.startLine; i++) {
          prefixLength += (bufferLines[i]?.length ?? 0) + 1;
        }
      }
      last.touchesDocumentEnd = true;
      last.text = headLf.slice(prefixLength);
    }
  }
  return edits;
}
