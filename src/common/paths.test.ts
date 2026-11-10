import { describe, it, expect } from 'vitest';
import { keyFor, normalizeRel, toRepoRel, fromRepoRel, PathSet } from './paths';

const isWin32 = process.platform === 'win32';

describe('normalizeRel', () => {
  it('unifies separators and strips trailing slash', () => {
    expect(normalizeRel('src\\app\\main.ts')).toBe('src/app/main.ts');
    expect(normalizeRel('src/app/')).toBe('src/app');
    expect(normalizeRel('src/app')).toBe('src/app');
  });
});

describe('keyFor', () => {
  it('case-folds on win32 only', () => {
    const key = keyFor('Src/App.TS');
    if (isWin32) {
      expect(key).toBe('src/app.ts');
    } else {
      expect(key).toBe('Src/App.TS');
    }
  });
});

describe('toRepoRel', () => {
  const root = isWin32 ? 'C:/repos/jetgit' : '/repos/jetgit';

  it('maps an absolute path inside the root', () => {
    expect(toRepoRel(`${root}/src/main.ts`, root)).toBe('src/main.ts');
  });

  it('returns undefined outside the root', () => {
    expect(toRepoRel(`${root}-sibling/src/main.ts`, root)).toBeUndefined();
  });

  it('is case-insensitive against the root on win32', () => {
    if (!isWin32) {
      return; // NTFS-specific behavior
    }
    expect(toRepoRel('C:/REPOS/JETGIT/src/main.ts', 'c:/repos/jetgit')).toBe('src/main.ts');
  });
});

describe('fromRepoRel', () => {
  it('joins with forward slashes', () => {
    const root = isWin32 ? 'C:/repos/jetgit' : '/repos/jetgit';
    expect(fromRepoRel('src/main.ts', root)).toBe(`${root}/src/main.ts`);
  });
});

describe('PathSet', () => {
  it('dedupes across separator and (on win32) case differences', () => {
    const set = new PathSet();
    set.add('src/App.ts');
    expect(set.has('src\\App.ts')).toBe(true);
    if (isWin32) {
      set.add('SRC/APP.TS');
      expect(set.size).toBe(1);
    } else {
      set.add('SRC/APP.TS');
      expect(set.size).toBe(2);
    }
    set.delete('src/app.ts'.replace('src', isWin32 ? 'SRC' : 'src'));
    if (isWin32) {
      expect(set.size).toBe(0);
    }
  });

  it('preserves original case in values', () => {
    const set = new PathSet();
    set.add('src/MyFile.TS');
    expect(set.values()).toEqual(['src/MyFile.TS']);
  });
});
