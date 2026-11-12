/**
 * Unit tests for the in-memory commit selection (checkbox state behind the
 * changelists tree): unchecked-set semantics, check/uncheck-all, the
 * checked subset that feeds commits, and reconcile-time pruning. Pure
 * module — no vscode.
 */
import { describe, expect, it } from 'vitest';
import { CommitSelection } from './selection';

const REPO = 'file:///repo';

describe('CommitSelection', () => {
  it('defaults to everything checked, including future members', () => {
    const s = new CommitSelection();
    expect(s.isChecked(REPO, 'cl1', 'a.txt')).toBe(true);
    expect(s.checkedSubset(REPO, 'cl1', ['a.txt', 'b.txt'])).toEqual(['a.txt', 'b.txt']);
  });

  it('unchecking one file keeps the others in the subset', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'b.txt', false);
    expect(s.isChecked(REPO, 'cl1', 'a.txt')).toBe(true);
    expect(s.isChecked(REPO, 'cl1', 'b.txt')).toBe(false);
    expect(s.checkedSubset(REPO, 'cl1', ['a.txt', 'b.txt'])).toEqual(['a.txt']);
  });

  it('re-checking removes the entry (set returns to pristine/all-checked)', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'b.txt', false);
    s.setChecked(REPO, 'cl1', 'b.txt', true);
    expect(s.isChecked(REPO, 'cl1', 'b.txt')).toBe(true);
  });

  it('uncheckAll marks exactly the given files; checkAll resets', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'a.txt', false);
    s.uncheckAll(REPO, 'cl1', ['a.txt', 'b.txt', 'c.txt']);
    expect(s.checkedSubset(REPO, 'cl1', ['a.txt', 'b.txt', 'c.txt'])).toEqual([]);
    s.checkAll(REPO, 'cl1');
    expect(s.checkedSubset(REPO, 'cl1', ['a.txt', 'b.txt', 'c.txt'])).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('state is per changelist and per repo', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'a.txt', false);
    expect(s.isChecked(REPO, 'cl2', 'a.txt')).toBe(true);
    expect(s.isChecked('file:///other', 'cl1', 'a.txt')).toBe(true);
  });

  it('isAllChecked equivalent: empty subset means nothing selected', () => {
    const s = new CommitSelection();
    s.uncheckAll(REPO, 'cl1', ['a.txt']);
    expect(s.checkedSubset(REPO, 'cl1', ['a.txt'])).toEqual([]);
  });

  it('pruneRepo drops paths that left the changelist and deleted changelists', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'a.txt', false);
    s.setChecked(REPO, 'cl1', 'gone.txt', false);
    s.setChecked(REPO, 'clX', 'z.txt', false);

    s.pruneRepo(REPO, [{ id: 'cl1', files: ['a.txt', 'b.txt'] }]);

    expect(s.isChecked(REPO, 'cl1', 'a.txt')).toBe(false); // member selection survives
    expect(s.isChecked(REPO, 'cl1', 'gone.txt')).toBe(true); // non-member selection pruned
    expect(s.isChecked(REPO, 'clX', 'z.txt')).toBe(true); // deleted changelist selection pruned
  });

  it('pruneRepo clears the materialized set when it becomes empty', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'stale.txt', false);
    s.pruneRepo(REPO, [{ id: 'cl1', files: ['a.txt'] }]);
    // internal set must be gone: re-adding then pruning again still works
    s.setChecked(REPO, 'cl1', 'b.txt', false);
    s.pruneRepo(REPO, [{ id: 'cl1', files: ['b.txt'] }]);
    expect(s.isChecked(REPO, 'cl1', 'b.txt')).toBe(false);
    expect(s.isChecked(REPO, 'cl1', 'a.txt')).toBe(true);
  });
});
