/**
 * Unit tests for the in-memory commit selection (checkbox state behind the
 * changelists tree): M6.7 flipped semantics — default UNCHECKED (IntelliJ's
 * commit list: the user marks what joins), checked-set storage, prune.
 * Pure module — no vscode.
 */
import { describe, expect, it } from 'vitest';
import { CommitSelection } from './selection';

const REPO = 'file:///repo';

describe('CommitSelection', () => {
  it('defaults to everything unchecked, including future members', () => {
    const s = new CommitSelection();
    expect(s.isChecked(REPO, 'cl1', 'a.txt')).toBe(false);
    expect(s.checkedSubset(REPO, 'cl1', ['a.txt', 'b.txt'])).toEqual([]);
  });

  it('checking one file keeps the others out of the subset', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'a.txt', true);
    expect(s.isChecked(REPO, 'cl1', 'a.txt')).toBe(true);
    expect(s.isChecked(REPO, 'cl1', 'b.txt')).toBe(false);
    expect(s.checkedSubset(REPO, 'cl1', ['a.txt', 'b.txt'])).toEqual(['a.txt']);
  });

  it('unchecking removes the entry (set returns to pristine/all-unchecked)', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'a.txt', true);
    s.setChecked(REPO, 'cl1', 'a.txt', false);
    expect(s.isChecked(REPO, 'cl1', 'a.txt')).toBe(false);
  });

  it('checkAll marks exactly the given files; uncheckAll resets', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'a.txt', true);
    s.checkAll(REPO, 'cl1', ['a.txt', 'b.txt', 'c.txt']);
    expect(s.checkedSubset(REPO, 'cl1', ['a.txt', 'b.txt', 'c.txt'])).toEqual(['a.txt', 'b.txt', 'c.txt']);
    s.uncheckAll(REPO, 'cl1');
    expect(s.checkedSubset(REPO, 'cl1', ['a.txt', 'b.txt', 'c.txt'])).toEqual([]);
  });

  it('state is per changelist and per repo', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'a.txt', true);
    expect(s.isChecked(REPO, 'cl2', 'a.txt')).toBe(false);
    expect(s.isChecked('file:///other', 'cl1', 'a.txt')).toBe(false);
  });

  it('pruneRepo drops paths that left the changelist and deleted changelists', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'a.txt', true);
    s.setChecked(REPO, 'cl1', 'gone.txt', true);
    s.setChecked(REPO, 'clX', 'z.txt', true);

    s.pruneRepo(REPO, [{ id: 'cl1', files: ['a.txt', 'b.txt'] }]);

    expect(s.isChecked(REPO, 'cl1', 'a.txt')).toBe(true); // member selection survives
    expect(s.isChecked(REPO, 'cl1', 'gone.txt')).toBe(false); // non-member selection pruned
    expect(s.isChecked(REPO, 'clX', 'z.txt')).toBe(false); // deleted changelist selection pruned
  });

  it('pruneRepo clears the materialized set when it becomes empty', () => {
    const s = new CommitSelection();
    s.setChecked(REPO, 'cl1', 'stale.txt', true);
    s.pruneRepo(REPO, [{ id: 'cl1', files: ['a.txt'] }]);
    // internal set must be gone: re-adding then pruning again still works
    s.setChecked(REPO, 'cl1', 'b.txt', true);
    s.pruneRepo(REPO, [{ id: 'cl1', files: ['b.txt'] }]);
    expect(s.isChecked(REPO, 'cl1', 'b.txt')).toBe(true);
    expect(s.isChecked(REPO, 'cl1', 'a.txt')).toBe(false);
  });
});
