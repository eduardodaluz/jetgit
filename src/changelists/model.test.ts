import { describe, it, expect } from 'vitest';
import * as model from './model';

describe('changelists model invariants', () => {
  it('createState has exactly one default active changelist', () => {
    const state = model.createState();
    expect(state.activeId).toBe(model.DEFAULT_CL_ID);
    expect(state.changelists).toHaveLength(1);
    expect(state.changelists[0]?.name).toBe('Changes');
  });

  it('ensureInvariants restores a missing default/active', () => {
    const broken: model.ChangelistsState = {
      version: 1,
      activeId: 'cl-missing',
      changelists: [{ id: 'cl-a', name: 'A', files: [] }],
    };
    const repaired = model.ensureInvariants(broken);
    expect(repaired.activeId).toBe(model.DEFAULT_CL_ID);
    expect(repaired.changelists.some((cl) => cl.id === model.DEFAULT_CL_ID)).toBe(true);
  });

  it('ensureInvariants dedupes a file present in two changelists', () => {
    const state: model.ChangelistsState = {
      version: 1,
      activeId: model.DEFAULT_CL_ID,
      changelists: [
        { id: model.DEFAULT_CL_ID, name: 'Changes', files: ['src/a.ts'] },
        { id: 'cl-b', name: 'B', files: ['src/a.ts', 'src/b.ts'] },
      ],
    };
    const repaired = model.ensureInvariants(state);
    expect(repaired.changelists.find((cl) => cl.id === 'cl-b')?.files).toEqual(['src/b.ts']);
  });

  it('moveFiles removes from every changelist and lands exactly once', () => {
    let state = model.createState();
    state = { ...state, changelists: [{ ...state.changelists[0]!, files: ['src/a.ts'] }, { id: 'cl-b', name: 'B', files: [] }] };
    state = model.moveFiles(state, ['src/a.ts'], 'cl-b');
    expect(state.changelists[0]?.files).toEqual([]);
    expect(state.changelists.find((cl) => cl.id === 'cl-b')?.files).toEqual(['src/a.ts']);

    // Unknown target is a no-op.
    const untouched = model.moveFiles(state, ['src/a.ts'], 'cl-does-not-exist');
    expect(untouched).toBe(state);
  });

  it('remove falls back members to the active changelist', () => {
    let state = model.createState();
    state = { ...state, changelists: [{ ...state.changelists[0]!, files: [] }, { id: 'cl-x', name: 'X', files: ['src/gone.ts'] }] };
    state = model.setActive(state, 'cl-x');
    state = model.remove(state, 'cl-x');
    expect(state.changelists.some((cl) => cl.id === 'cl-x')).toBe(false);
    expect(state.activeId).toBe(model.DEFAULT_CL_ID);
    expect(state.changelists[0]?.files).toEqual(['src/gone.ts']);
  });

  it('remove refuses to delete the default changelist', () => {
    const state = model.createState();
    expect(model.remove(state, model.DEFAULT_CL_ID)).toBe(state);
  });

  it('reconcile drops paths that left status and assigns new ones to active', () => {
    let state = model.createState();
    state = { ...state, changelists: [{ ...state.changelists[0]!, files: ['src/committed.ts', 'src/still-dirty.ts'] }] };
    state = model.create(state, 'feature');
    const featureId = state.changelists[1]!.id;
    state = model.setActive(state, featureId);

    const next = model.reconcile(state, ['src/still-dirty.ts', 'src/new-edit.ts'], { autoAssign: true });
    expect(next.changelists[0]?.files).toEqual(['src/still-dirty.ts']);
    expect(next.changelists.find((cl) => cl.id === featureId)?.files).toEqual(['src/new-edit.ts']);
  });

  it('reconcile with autoAssign:false leaves new paths unassigned', () => {
    const state = model.createState();
    const next = model.reconcile(state, ['src/new.ts'], { autoAssign: false });
    expect(next.changelists[0]?.files).toEqual([]);
  });

  it('membersWithChanges intersects case-insensitively on win32', () => {
    const isWin32 = process.platform === 'win32';
    let state = model.createState();
    state = { ...state, changelists: [{ ...state.changelists[0]!, files: [isWin32 ? 'SRC/App.ts' : 'src/app.ts'] }] };
    const members = model.membersWithChanges(state, model.DEFAULT_CL_ID, ['src/app.ts']);
    expect(members).toEqual([isWin32 ? 'SRC/App.ts' : 'src/app.ts']);
  });

  it('isLoadable rejects unknown schema versions', () => {
    expect(model.isLoadable({ version: 2, changelists: [] })).toBe(false);
    expect(model.isLoadable({ version: 1, changelists: [] })).toBe(true);
    expect(model.isLoadable(null)).toBe(false);
  });
});
