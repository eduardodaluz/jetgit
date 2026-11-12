/**
 * Unit tests for the partial-rollback core: -U0 hunk parsing (headers with
 * count elision, creation/deletion hunks, \ No newline markers) and the
 * edit math (selection mapping in both spaces, EOF round-trips via the
 * prefix-slice rule, stale-hunk drops). Pure module — no vscode.
 */
import { describe, expect, it } from 'vitest';
import { computeRollbackEdits, parseHunks, splitLfLines, toLf, type LineSelection } from './rollbackQuery';

describe('toLf / splitLfLines', () => {
  it('normalizes CRLF and never lone CR', () => {
    expect(toLf('a\r\nb\rc\n')).toBe('a\nb\rc\n');
    expect(toLf('')).toBe('');
  });

  it('splits lines and drops the trailing phantom', () => {
    expect(splitLfLines('')).toEqual([]);
    expect(splitLfLines('\n')).toEqual(['']);
    expect(splitLfLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLfLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLfLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });
});

describe('parseHunks', () => {
  it('returns [] for empty or undiffable input', () => {
    expect(parseHunks('')).toEqual([]);
    expect(parseHunks('diff --git a/f b/f\nindex 123..456 100644\n')).toEqual([]);
  });

  it('parses modified hunks with explicit counts', () => {
    const hunks = parseHunks(['@@ -1,2 +1,3 @@', '+zero', '-one', '+ONE', '-two', '+two!'].join('\n'));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 });
    expect(hunks[0]?.oldLines).toEqual(['one', 'two']);
    expect(hunks[0]?.newLines).toEqual(['zero', 'ONE', 'two!']);
  });

  it('elides ,1 counts on both sides', () => {
    const hunks = parseHunks('@@ -2 +2 @@\n-old\n+new\n');
    expect(hunks[0]).toMatchObject({ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, oldLines: ['old'], newLines: ['new'] });
  });

  it('parses creation (-0,0) and deletion (+N,0) hunks', () => {
    const creation = parseHunks('@@ -0,0 +1,2 @@\n+new file\n+line two\n');
    expect(creation[0]).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2, oldLines: [], newLines: ['new file', 'line two'] });

    const deletion = parseHunks('@@ -3 +2,0 @@\n-gone\n');
    expect(deletion[0]).toMatchObject({ oldStart: 3, oldCount: 1, newStart: 2, newCount: 0, oldLines: ['gone'], newLines: [] });
  });

  it('skips \\ No newline markers and keeps counts exact', () => {
    const diff = ['@@ -2 +2 @@', '-l2', '\\ No newline at end of file', '+l2', ''].join('\n');
    const hunks = parseHunks(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, oldLines: ['l2'], newLines: ['l2'] });
  });

  it('keeps function-context suffix out of the header match and parses multiple hunks', () => {
    const diff = ['@@ -1 +1 @@ cb(x)', '-a', '+A', '@@ -10 +10 @@ other()', '-b', '+B', ''].join('\n');
    const hunks = parseHunks(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(hunks[1]).toMatchObject({ oldStart: 10, newStart: 10, oldLines: ['b'] });
  });

  it('drops impossible hunks (parse drift safety)', () => {
    expect(parseHunks('@@ -1,2 +1,1 @@\n-a\n+only\n')).toEqual([]);
  });
});

describe('computeRollbackEdits', () => {
  const sel = (first: number, last: number): LineSelection => ({ first, last });

  it('rolls back the middle of three distant hunks', () => {
    const headLf = 'l1\nl2\nl3\n';
    const bufferLf = 'L1\nlX\nL3\n';
    const hunks = parseHunks('@@ -1 +1 @@\n-l1\n+L1\n@@ -2 +2 @@\n-l2\n+lX\n@@ -3 +3 @@\n-l3\n+L3\n');
    const edits = computeRollbackEdits(headLf, bufferLf, hunks, [sel(1, 1)], 'new');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ startLine: 1, endLineExclusive: 2, text: 'l2\n', touchesDocumentEnd: false });
  });

  it('full rollback (null selection) restores every hunk', () => {
    const headLf = 'l1\nl2\nl3\n';
    const bufferLf = 'L1\nlX\nL3\n';
    const hunks = parseHunks('@@ -1 +1 @@\n-l1\n+L1\n@@ -3 +3 @@\n-l3\n+L3\n');
    const edits = computeRollbackEdits(headLf, bufferLf, hunks, null, 'new');
    // The last hunk reaches EOF (buffer ends with \n), so it takes the slice text.
    expect(edits.map((e) => [e.startLine, e.endLineExclusive, e.text])).toEqual([[0, 1, 'l1\n'], [2, 3, 'l3\n']]);
  });

  it('maps old-space selections through hunk old ranges', () => {
    const hunks = parseHunks('@@ -5 +5 @@\n-old\n+new\n');
    const edits = computeRollbackEdits('a\nb\nc\nd\nold\nf\n', 'a\nb\nc\nd\nnew\nf\n', hunks, [sel(4, 4)], 'old');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toBe('old\n');
  });

  it('never selects pure additions in old space', () => {
    const hunks = parseHunks('@@ -2,0 +3,1 @@\n+added\n');
    const edits = computeRollbackEdits('a\nb\n', 'a\nb\nadded\n', hunks, [sel(0, 10)], 'old');
    expect(edits).toEqual([]);
  });

  it('selects the line before the gap for pure deletions in new space', () => {
    // HEAD a,b,c,d → buffer a,c,d: gap after new line 1 → footprint line 0.
    const hunks = parseHunks('@@ -2 +1,0 @@\n-b\n');
    const edits = computeRollbackEdits('a\nb\nc\nd\n', 'a\nc\nd\n', hunks, [sel(0, 0)], 'new');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ startLine: 1, endLineExclusive: 1, text: 'b\n' });
  });

  it('drops stale hunks that exceed the buffer', () => {
    const hunks = parseHunks('@@ -5 +5 @@\n-x\n+y\n');
    const edits = computeRollbackEdits('a\n', 'a\n', hunks, null, 'new');
    expect(edits).toEqual([]);
  });

  // The EOF table: the last edit reaching document end takes
  // text = headLf.slice(prefix) — every trailing-newline transition round-trips.
  it('EOF case 1 — replace reaching EOF, both end with newline', () => {
    const hunks = parseHunks('@@ -2 +2 @@\n-l2\n+lX\n');
    const edits = computeRollbackEdits('l1\nl2\n', 'l1\nlX\n', hunks, null, 'new');
    expect(edits[0]).toMatchObject({ startLine: 1, endLineExclusive: 2, text: 'l2\n', touchesDocumentEnd: true });
  });

  it('EOF case 2 — neither side ends with newline', () => {
    const hunks = parseHunks('@@ -2 +2 @@\n-l2\n+lX\n');
    const edits = computeRollbackEdits('l1\nl2', 'l1\nlX', hunks, null, 'new');
    expect(edits[0]).toMatchObject({ text: 'l2', touchesDocumentEnd: true });
  });

  it('EOF case 3 — buffer lost the final newline, rollback restores it', () => {
    const hunks = parseHunks('@@ -2 +2 @@\n-l2\n+l2\n');
    const edits = computeRollbackEdits('l1\nl2\n', 'l1\nl2', hunks, null, 'new');
    expect(edits[0]).toMatchObject({ text: 'l2\n', touchesDocumentEnd: true });
  });

  it('EOF case 4 — buffer added the final newline, rollback removes it', () => {
    const hunks = parseHunks('@@ -2 +2 @@\n-l2\n+l2\n');
    const edits = computeRollbackEdits('l1\nl2', 'l1\nl2\n', hunks, null, 'new');
    expect(edits[0]).toMatchObject({ text: 'l2', touchesDocumentEnd: true });
  });

  it('EOF case 5 — pure addition at EOF without newline is removed cleanly', () => {
    const hunks = parseHunks('@@ -2,0 +3 @@\n+l3\n');
    const edits = computeRollbackEdits('l1\nl2\n', 'l1\nl2\nl3', hunks, null, 'new');
    expect(edits[0]).toMatchObject({ startLine: 2, endLineExclusive: 3, text: '', touchesDocumentEnd: true });
  });

  it('EOF case 6 — pure addition at EOF with newline is removed cleanly', () => {
    const hunks = parseHunks('@@ -2,0 +3 @@\n+l3\n');
    const edits = computeRollbackEdits('l1\nl2\n', 'l1\nl2\nl3\n', hunks, null, 'new');
    expect(edits[0]).toMatchObject({ startLine: 2, endLineExclusive: 3, text: '', touchesDocumentEnd: true });
  });

  it('EOF case 7 — deletion rollback at EOF appends with the head newline', () => {
    const hunks = parseHunks('@@ -3 +2,0 @@\n-c\n');
    const edits = computeRollbackEdits('a\nb\nc\n', 'a\nb\n', hunks, null, 'new');
    expect(edits[0]).toMatchObject({ startLine: 2, endLineExclusive: 2, text: 'c\n', touchesDocumentEnd: true });
  });

  it('EOF case 8 — mid-document edits never touch the document end', () => {
    const hunks = parseHunks('@@ -2 +2 @@\n-l2\n+lX\n');
    const edits = computeRollbackEdits('l1\nl2\nl3\nl4\n', 'l1\nlX\nl3\nl4\n', hunks, null, 'new');
    expect(edits[0]).toMatchObject({ startLine: 1, endLineExclusive: 2, text: 'l2\n', touchesDocumentEnd: false });
  });

  it('a full rollback of everything is exactly the head content', () => {
    const headLf = 'h1\nh2\nh3\nh4\nh5\n';
    const bufferLf = 'h1\nb2\nh3\nb4\nb5\n';
    const hunks = parseHunks('@@ -2 +2 @@\n-h2\n+b2\n@@ -4,2 +4,2 @@\n-h4\n-h5\n+b4\n+b5\n');
    const edits = computeRollbackEdits(headLf, bufferLf, hunks, null, 'new');
    expect(assemble(bufferLf, edits)).toBe(headLf);
  });
});

/**
 * Applies LineEdits in LF space exactly the way the command layer builds
 * TextEdits: non-EOF replaces span [lineAt(s).start, lineAt(e).start),
 * insertions land at lineAt(startLine).start, and document-end edits anchor
 * the range at positionAt(text length) (= bufferLf.length in LF space).
 */
function assemble(bufferLf: string, edits: readonly { startLine: number; endLineExclusive: number; text: string; touchesDocumentEnd: boolean }[]): string {
  const lines = splitLfLines(bufferLf);
  const starts: number[] = [];
  let off = 0;
  for (const line of lines) {
    starts.push(off);
    off += line.length + 1;
  }
  const docLen = bufferLf.length;
  let result = bufferLf;
  for (const edit of [...edits].reverse()) {
    if (edit.touchesDocumentEnd) {
      const start = edit.endLineExclusive > edit.startLine && edit.startLine < lines.length ? starts[edit.startLine]! : docLen;
      result = result.slice(0, start) + edit.text;
    } else if (edit.endLineExclusive === edit.startLine) {
      const at = edit.startLine < lines.length ? starts[edit.startLine]! : docLen;
      result = result.slice(0, at) + edit.text + result.slice(at);
    } else {
      const s = starts[edit.startLine]!;
      const e = starts[edit.endLineExclusive]!;
      result = result.slice(0, s) + edit.text + result.slice(e);
    }
  }
  return result;
}

describe('computeRollbackEdits — assembled round-trips', () => {
  const rollback = (headLf: string, bufferLf: string, diff: string, selections: LineSelection[] | null = null): string => {
    const hunks = parseHunks(diff);
    return assemble(bufferLf, computeRollbackEdits(headLf, bufferLf, hunks, selections, 'new'));
  };

  it('the 8 EOF table cases all round-trip to the head content', () => {
    // 1 replace reaching EOF, both sides end with newline
    expect(rollback('l1\nl2\n', 'l1\nlX\n', '@@ -2 +2 @@\n-l2\n+lX\n')).toBe('l1\nl2\n');
    // 2 neither side ends with newline
    expect(rollback('l1\nl2', 'l1\nlX', '@@ -2 +2 @@\n-l2\n+lX\n')).toBe('l1\nl2');
    // 3 buffer lost the final newline
    expect(rollback('l1\nl2\n', 'l1\nl2', '@@ -2 +2 @@\n-l2\n+l2\n')).toBe('l1\nl2\n');
    // 4 buffer added the final newline
    expect(rollback('l1\nl2', 'l1\nl2\n', '@@ -2 +2 @@\n-l2\n+l2\n')).toBe('l1\nl2');
    // 5 pure addition at EOF without newline
    expect(rollback('l1\nl2\n', 'l1\nl2\nl3', '@@ -2,0 +3 @@\n+l3\n')).toBe('l1\nl2\n');
    // 6 pure addition at EOF with newline
    expect(rollback('l1\nl2\n', 'l1\nl2\nl3\n', '@@ -2,0 +3 @@\n+l3\n')).toBe('l1\nl2\n');
    // 7 deletion rollback at EOF
    expect(rollback('a\nb\nc\n', 'a\nb\n', '@@ -3 +2,0 @@\n-c\n')).toBe('a\nb\nc\n');
    // 8 mid-document edit never disturbs the ending
    expect(rollback('l1\nl2\nl3\nl4\n', 'l1\nlX\nl3\nl4\n', '@@ -2 +2 @@\n-l2\n+lX\n')).toBe('l1\nl2\nl3\nl4\n');
  });

  it('full rollback of a whole rewritten file reproduces head byte-exactly', () => {
    const headLf = 'alpha\nbeta\ngamma\ndelta\n';
    const bufferLf = 'alpha\nBETA\ngamma\nDELTA\nepsilon\n';
    const diff = '@@ -2 +2 @@\n-beta\n+BETA\n@@ -4 +4 @@\n-delta\n+DELTA\n@@ -4,0 +5 @@\n+epsilon\n';
    expect(rollback(headLf, bufferLf, diff)).toBe(headLf);
  });

  it('a partial selection leaves other hunks untouched', () => {
    const headLf = 'a\nb\nc\n';
    const bufferLf = 'A\nb\nC\n';
    const diff = '@@ -1 +1 @@\n-a\n+A\n@@ -3 +3 @@\n-c\n+C\n';
    expect(rollback(headLf, bufferLf, diff, [{ first: 2, last: 2 }])).toBe('A\nb\nc\n');
  });

  it('empty-file head restores to empty', () => {
    expect(rollback('', 'x', '@@ -0,0 +1 @@\n+x\n')).toBe('');
  });
});
