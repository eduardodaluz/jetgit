/**
 * Unit tests for the review-session store behind the diff hunk checkboxes:
 * content+ordinal signatures (stable under upstream shifts), effective-set
 * intersection, toggle seeding + folding, and reconcile pruning. Pure
 * module — no vscode.
 */
import { describe, expect, it } from 'vitest';
import {
  allSignatures,
  effectiveSignatures,
  entryState,
  fnv1a32,
  HunkSelectionStore,
  hunkSignature,
  reviewKey,
  type SigSource,
} from './hunkSelection';

const REPO = 'file:///repo';

function hunk(oldCount: number, newCount: number, oldLines: string[], newLines: string[]): SigSource {
  return { oldCount, newCount, oldLines, newLines };
}

describe('signatures', () => {
  it('fnv1a32 is deterministic and input-sensitive', () => {
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'));
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abd'));
    expect(fnv1a32('')).toBe('811c9dc5'); // FNV-1a basis
  });

  it('signatures survive upstream line shifts (no line numbers hashed)', () => {
    const before = [hunk(1, 1, ['old'], ['new'])];
    const after = [hunk(1, 1, ['shifted-context'], ['shifted']), hunk(1, 1, ['old'], ['new'])];
    expect(hunkSignature(before, 0)).toBe(hunkSignature(after, 1));
  });

  it('identical adjacent hunks get distinct ordinals that track duplicates', () => {
    const dup = [hunk(1, 1, ['x'], ['y']), hunk(1, 1, ['x'], ['y'])];
    // An unrelated upstream change + the same duplicate pair, shifted positions.
    const shifted = [hunk(2, 1, ['p', 'q'], ['r']), hunk(1, 1, ['x'], ['y']), hunk(1, 1, ['x'], ['y'])];
    const sigs0 = allSignatures(dup);
    const sigs1 = allSignatures(shifted);
    expect(sigs0[0]).not.toBe(sigs0[1]);
    expect(sigs1[0]).not.toBe(sigs0[0]); // the unrelated hunk hashes differently
    expect(sigs1.slice(1)).toEqual(sigs0); // duplicate ordinals follow the duplicates, not positions
    expect(hunkSignature(dup, 2)).toBe(''); // out of range → safe empty
  });

  it('pure add/delete hunks (empty side) hash fine', () => {
    const sigs = allSignatures([hunk(0, 1, [], ['added']), hunk(1, 0, ['deleted'], [])]);
    expect(new Set(sigs).size).toBe(2);
  });

  it('effective = intent ∩ current signatures', () => {
    const session = {
      signatures: ['a', 'b', 'c'],
      included: new Set(['a', 'b', 'gone']),
    };
    expect(effectiveSignatures(session)).toEqual(['a', 'b']);
  });
});

describe('entryState', () => {
  it('truth table: partial beats whole, absence falls back to the tree', () => {
    expect(entryState({ hasSession: true, effectiveCount: 2, treeChecked: true })).toBe('partial');
    expect(entryState({ hasSession: true, effectiveCount: 1, treeChecked: false })).toBe('partial');
    expect(entryState({ hasSession: false, effectiveCount: 0, treeChecked: true })).toBe('whole');
    expect(entryState({ hasSession: false, effectiveCount: 0, treeChecked: false })).toBe('excluded');
    // session with zero effective is inert — tree decides
    expect(entryState({ hasSession: true, effectiveCount: 0, treeChecked: true })).toBe('whole');
  });
});

describe('HunkSelectionStore', () => {
  const sigs3 = ['#01', '#02', '#03'];

  it('openSession starts with empty intent; counts report 0/total', () => {
    const store = new HunkSelectionStore();
    store.openSession(REPO, 'f.txt', sigs3);
    expect(store.counts(REPO, 'f.txt')).toEqual({ included: 0, total: 3 });
    expect(store.isPartial(REPO, 'f.txt')).toBe(false);
  });

  it('toggle seeds from the tree state: unchecked file → {that hunk}', () => {
    const store = new HunkSelectionStore();
    store.openSession(REPO, 'f.txt', sigs3);
    const outcome = store.toggle(REPO, 'f.txt', 1, false);
    expect(outcome).toBe('included');
    expect(store.counts(REPO, 'f.txt')).toEqual({ included: 1, total: 3 });
  });

  it('toggle seeds all-minus-one from a tree-checked (whole) file', () => {
    const store = new HunkSelectionStore();
    store.openSession(REPO, 'f.txt', sigs3);
    // The toggled hunk is the one EXCLUDED from the seed — its new state is 'excluded'.
    const outcome = store.toggle(REPO, 'f.txt', 1, true);
    expect(outcome).toBe('excluded');
    expect(store.counts(REPO, 'f.txt')).toEqual({ included: 2, total: 3 });
  });

  it('folds to whole when everything is included, clearing the session', () => {
    const store = new HunkSelectionStore();
    store.openSession(REPO, 'f.txt', sigs3);
    store.toggle(REPO, 'f.txt', 0, false);
    store.toggle(REPO, 'f.txt', 1, false);
    const outcome = store.toggle(REPO, 'f.txt', 2, false);
    expect(outcome).toBe('folded-whole');
    expect(store.session(REPO, 'f.txt')).toBeUndefined();
  });

  it('folds to excluded when intent empties, clearing the session', () => {
    const store = new HunkSelectionStore();
    store.openSession(REPO, 'f.txt', sigs3);
    store.toggle(REPO, 'f.txt', 0, false);
    const outcome = store.toggle(REPO, 'f.txt', 0, false);
    expect(outcome).toBe('folded-excluded');
    expect(store.session(REPO, 'f.txt')).toBeUndefined();
  });

  it('unchecking the only hunk of a seeded-all file folds back to excluded', () => {
    const store = new HunkSelectionStore();
    store.openSession(REPO, 'f.txt', [soloSig]);
    const outcome = store.toggle(REPO, 'f.txt', 0, true);
    expect(outcome).toBe('folded-excluded');
    expect(store.session(REPO, 'f.txt')).toBeUndefined();
  });

  it('refreshSignatures keeps intent but drops it from counts when stale', () => {
    const store = new HunkSelectionStore();
    store.openSession(REPO, 'f.txt', sigs3);
    store.toggle(REPO, 'f.txt', 0, false);
    store.refreshSignatures(REPO, 'f.txt', ['#77', '#88']);
    expect(store.counts(REPO, 'f.txt')).toEqual({ included: 0, total: 2 });
  });

  it('sessions are keyed per repo+path', () => {
    const store = new HunkSelectionStore();
    store.openSession(REPO, 'f.txt', sigs3);
    expect(store.session(REPO, 'g.txt')).toBeUndefined();
    expect(store.session('file:///other', 'f.txt')).toBeUndefined();
    expect(reviewKey(REPO, 'f.txt')).toContain('\0');
  });

  it('pruneRepo closes sessions for paths that left the status', () => {
    const store = new HunkSelectionStore();
    store.openSession(REPO, 'keep.txt', sigs3);
    store.openSession(REPO, 'gone.txt', sigs3);
    store.pruneRepo(REPO, new Set(['keep.txt']));
    expect(store.session(REPO, 'keep.txt')).toBeDefined();
    expect(store.session(REPO, 'gone.txt')).toBeUndefined();
  });
});

const soloSig = '#solo';
