import { describe, it, expect } from 'vitest';
import { parsePatch } from './patchInfo';

function trackedPatch(): string {
  return [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    'diff --git a/src/b.ts b/src/b.ts',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1,1 @@',
    '+content',
    'diff --git a/img/logo.bin b/img/logo.bin',
    'new file mode 100644',
    'index 0000000..4444444',
    'GIT binary patch',
    'literal 4',
    'YmNkZWUK',
    '',
  ].join('\n');
}

describe('parsePatch', () => {
  it('extracts per-file entries with byte ranges', () => {
    const patch = Buffer.from(trackedPatch(), 'latin1');
    const entries = parsePatch(patch);
    expect(entries.map((e) => e.path)).toEqual(['src/a.ts', 'src/b.ts', 'img/logo.bin']);
    expect(entries.find((e) => e.path === 'src/a.ts')?.isNew).toBe(false);
    expect(entries.find((e) => e.path === 'src/b.ts')?.isNew).toBe(true);
    expect(entries.find((e) => e.path === 'img/logo.bin')?.isBinary).toBe(true);
  });

  it('segments reassemble the original buffer byte-exact', () => {
    const patch = Buffer.from(trackedPatch() + '\n' + trackedPatch(), 'latin1');
    const entries = parsePatch(patch);
    const rebuilt = Buffer.concat(entries.map((e) => patch.subarray(e.start, e.end)));
    expect(rebuilt.equals(patch)).toBe(true);
  });

  it('marks deleted files and resolves path from the --- side', () => {
    const patch = Buffer.from(
      [
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        'index 5555555..0000000',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
      ].join('\n'),
      'latin1',
    );
    const entries = parsePatch(patch);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: 'gone.txt', isDeleted: true });
  });

  it('handles quoted unicode paths', () => {
    const patch = Buffer.from(
      [
        'diff --git "a/docs/\\303\\251\\303\\250.md" "b/docs/\\303\\251\\303\\250.md"',
        'index 1111111..2222222 100644',
        '--- "a/docs/\\303\\251\\303\\250.md"',
        '+++ "b/docs/\\303\\251\\303\\250.md"',
        '@@ -1 +1 @@',
      ].join('\n'),
      'latin1',
    );
    const entries = parsePatch(patch);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('docs/éè.md');
  });

  it('returns empty for an empty or non-patch buffer', () => {
    expect(parsePatch(Buffer.alloc(0))).toEqual([]);
    expect(parsePatch(Buffer.from('hello world\n'))).toEqual([]);
  });

  it('ignores "diff --git " appearing inside content lines', () => {
    const patch = Buffer.from(
      [
        'diff --git a/real.ts b/real.ts',
        'index 1111111..2222222 100644',
        '--- a/real.ts',
        '+++ b/real.ts',
        '@@ -1,2 +1,2 @@',
        '-const note = "diff --git not a header";',
        '+const note = "diff --git still not a header";',
      ].join('\n'),
      'latin1',
    );
    const entries = parsePatch(patch);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('real.ts');
  });
});
