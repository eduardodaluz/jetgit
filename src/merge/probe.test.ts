/**
 * Unit tests for the pure merge probe (M6.8): porcelain v1 -z parsing
 * (empirical format: each record is ONE NUL token, "XY<space>PATH"; rename/
 * copy records carry the original path as a second bare token), the unmerged
 * matrix, operation detection precedence, the full 7×2 resolvePlan matrix,
 * and snapshot building.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  detectOperation,
  isUnmerged,
  parseStatusPorcelainV1Z,
  resolvePlan,
  unmergedCode,
  type OperationFlags,
  type PorcelainEntry,
  type UnmergedCode,
} from './probe';

const z = (s: string): string => s.split('|').join('\0');

describe('parseStatusPorcelainV1Z', () => {
  it('parses UU and AA conflict entries', () => {
    const entries = parseStatusPorcelainV1Z(z('UU a.txt|AA b.txt|'));
    expect(entries).toEqual([
      { x: 'U', y: 'U', path: 'a.txt' },
      { x: 'A', y: 'A', path: 'b.txt' },
    ]);
  });

  it('parses a mixed status (conflicts, staged, untracked)', () => {
    const entries = parseStatusPorcelainV1Z(z('UU f1.txt|UU f2.txt|UD keep.txt|D  old.txt|AA renamed.txt|?? new.txt|M  staged.txt|'));
    expect(entries.map((e) => `${e.x}${e.y} ${e.path}`)).toEqual([
      'UU f1.txt',
      'UU f2.txt',
      'UD keep.txt',
      'D  old.txt',
      'AA renamed.txt',
      '?? new.txt',
      'M  staged.txt',
    ]);
  });

  it('rename/copy records consume a second bare token (the original path)', () => {
    const entries = parseStatusPorcelainV1Z(z('R  new-name.txt|old-name.txt|M  other.txt|'));
    expect(entries).toEqual([
      { x: 'R', y: ' ', path: 'new-name.txt', origPath: 'old-name.txt' },
      { x: 'M', y: ' ', path: 'other.txt' },
    ]);
    const copy = parseStatusPorcelainV1Z(z('C  dst.txt|src.txt|'))[0];
    expect(copy?.origPath).toBe('src.txt');
  });

  it('paths with spaces and unicode names survive intact', () => {
    const entries = parseStatusPorcelainV1Z(z('UU my file.txt|AU arquivoção.txt|UA 中文 文件.md|'));
    expect(entries.map((e) => e.path)).toEqual(['my file.txt', 'arquivoção.txt', '中文 文件.md']);
  });

  it('skips the trailing NUL and empty tokens', () => {
    expect(parseStatusPorcelainV1Z(z('UU a.txt||'))).toEqual([{ x: 'U', y: 'U', path: 'a.txt' }]);
    expect(parseStatusPorcelainV1Z('')).toEqual([]);
  });

  it('drops malformed records without throwing', () => {
    const entries = parseStatusPorcelainV1Z(z('garbage|UU good.txt|x|'));
    expect(entries).toEqual([{ x: 'U', y: 'U', path: 'good.txt' }]);
  });

  it('handles a truncated rename record (no original token)', () => {
    const entries = parseStatusPorcelainV1Z(z('R  lonely.txt|'));
    expect(entries).toEqual([{ x: 'R', y: ' ', path: 'lonely.txt' }]);
  });
});

describe('isUnmerged / unmergedCode', () => {
  const entry = (xy: string): PorcelainEntry => ({ x: xy[0] ?? '?', y: xy[1] ?? '?', path: 'p' });

  it('accepts exactly the seven unmerged codes', () => {
    const codes: UnmergedCode[] = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
    for (const code of codes) {
      expect(unmergedCode(entry(code))).toBe(code);
      expect(isUnmerged(entry(code))).toBe(true);
    }
  });

  it('rejects every non-unmerged state', () => {
    for (const xy of ['M ', ' M', 'A ', 'D ', '??', '!!', 'R ', 'C ', 'T ', 'AM', 'MM']) {
      expect(unmergedCode(entry(xy))).toBeUndefined();
      expect(isUnmerged(entry(xy))).toBe(false);
    }
  });
});

describe('detectOperation', () => {
  const flags = (partial: Partial<OperationFlags>): OperationFlags => partial;

  it('single flags map to their operation', () => {
    expect(detectOperation(flags({ mergeHead: true }))).toBe('merge');
    expect(detectOperation(flags({ cherryPickHead: true }))).toBe('cherry-pick');
    expect(detectOperation(flags({ revertHead: true }))).toBe('revert');
    expect(detectOperation(flags({ rebaseMerge: true }))).toBe('rebase');
    expect(detectOperation(flags({ rebaseApply: true }))).toBe('rebase');
  });

  it('precedence: merge > cherry-pick > revert > rebase > unknown', () => {
    expect(
      detectOperation(flags({ mergeHead: true, cherryPickHead: true, revertHead: true, rebaseMerge: true })),
    ).toBe('merge');
    expect(detectOperation(flags({ cherryPickHead: true, revertHead: true, rebaseApply: true }))).toBe('cherry-pick');
    expect(detectOperation(flags({ revertHead: true, rebaseMerge: true }))).toBe('revert');
    expect(detectOperation(flags({}))).toBe('unknown');
  });
});

describe('resolvePlan — full 7×2 matrix', () => {
  const codes: UnmergedCode[] = ['UU', 'AA', 'AU', 'UD', 'UA', 'DU', 'DD'];

  it('UU/AA: either side checks out then stages', () => {
    for (const code of ['UU', 'AA'] as const) {
      expect(resolvePlan(code, 'ours')).toEqual({ kind: 'checkout', side: 'ours' });
      expect(resolvePlan(code, 'theirs')).toEqual({ kind: 'checkout', side: 'theirs' });
    }
  });

  it('AU added-by-us: ours stages only, theirs removes', () => {
    expect(resolvePlan('AU', 'ours')).toEqual({ kind: 'stage' });
    expect(resolvePlan('AU', 'theirs')).toEqual({ kind: 'remove' });
  });

  it('DU deleted-by-us: theirs stages only, ours removes', () => {
    expect(resolvePlan('DU', 'theirs')).toEqual({ kind: 'stage' });
    expect(resolvePlan('DU', 'ours')).toEqual({ kind: 'remove' });
  });

  it('UD deleted-by-them: ours checks out, theirs removes', () => {
    expect(resolvePlan('UD', 'ours')).toEqual({ kind: 'checkout', side: 'ours' });
    expect(resolvePlan('UD', 'theirs')).toEqual({ kind: 'remove' });
  });

  it('UA deleted-by-us: theirs checks out, ours removes', () => {
    expect(resolvePlan('UA', 'theirs')).toEqual({ kind: 'checkout', side: 'theirs' });
    expect(resolvePlan('UA', 'ours')).toEqual({ kind: 'remove' });
  });

  it('DD both deleted: either side removes', () => {
    for (const side of ['ours', 'theirs'] as const) {
      expect(resolvePlan('DD', side)).toEqual({ kind: 'remove' });
    }
  });

  it('every combination is covered by exactly one plan kind', () => {
    for (const code of codes) {
      for (const side of ['ours', 'theirs'] as const) {
        const plan = resolvePlan(code, side);
        expect(['checkout', 'stage', 'remove']).toContain(plan.kind);
      }
    }
  });
});

describe('buildSnapshot', () => {
  it('collects only unmerged paths with their codes', () => {
    const snapshot = buildSnapshot(
      { mergeHead: true },
      z('UU a.txt|M  b.txt|UD c.txt|?? d.txt|AU e.txt|'),
    );
    expect(snapshot.operation).toBe('merge');
    expect(snapshot.conflicts).toEqual([
      { path: 'a.txt', code: 'UU' },
      { path: 'c.txt', code: 'UD' },
      { path: 'e.txt', code: 'AU' },
    ]);
  });

  it('counts conflicts for a fully resolved merge (ready to commit)', () => {
    const snapshot = buildSnapshot({ mergeHead: true }, z('M  a.txt|M  b.txt|'));
    expect(snapshot.conflicts).toEqual([]);
    expect(snapshot.operation).toBe('merge');
  });

  it('carries the rebase operation with its conflicts', () => {
    const snapshot = buildSnapshot({ rebaseMerge: true }, z('UU f.txt|'));
    expect(snapshot.operation).toBe('rebase');
    expect(snapshot.conflicts).toEqual([{ path: 'f.txt', code: 'UU' }]);
  });

  it('unknown operation still reports lingering unmerged entries', () => {
    const snapshot = buildSnapshot({}, z('DU g.txt|'));
    expect(snapshot.operation).toBe('unknown');
    expect(snapshot.conflicts).toEqual([{ path: 'g.txt', code: 'DU' }]);
  });
});
