/**
 * Pure changelist operations over the persisted state shape.
 * No vscode/git imports — every rule here is unit-testable and every rule
 * is an invariant:
 *   - exactly one active changelist, which always exists (cl-default)
 *   - a file lives in AT MOST ONE changelist
 *   - paths are stored with '/' separators and compared case-folded on win32
 */
import { keyFor } from '../common/paths';
import { randomUUID } from 'node:crypto';

export interface Changelist {
  id: string;
  name: string;
  /** Pre-fills the commit message. */
  comment?: string;
  /** Repo-relative paths, original case preserved. */
  files: string[];
}

export interface ChangelistsState {
  version: 1;
  activeId: string;
  changelists: Changelist[];
}

export const DEFAULT_CL_ID = 'cl-default';
export const DEFAULT_CL_NAME = 'Changes';

export function createState(): ChangelistsState {
  return {
    version: 1,
    activeId: DEFAULT_CL_ID,
    changelists: [{ id: DEFAULT_CL_ID, name: DEFAULT_CL_NAME, files: [] }],
  };
}

/** Forward-compat: unknown schema versions must never be silently rewritten. */
export function isLoadable(value: unknown): value is ChangelistsState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { changelists?: unknown }).changelists)
  );
}

/** Repairs drift (missing default/active) without discarding user data. */
export function ensureInvariants(state: ChangelistsState): ChangelistsState {
  let defaultCl = state.changelists.find((cl) => cl.id === DEFAULT_CL_ID);
  if (!defaultCl) {
    defaultCl = { id: DEFAULT_CL_ID, name: DEFAULT_CL_NAME, files: [] };
    state.changelists.unshift(defaultCl);
  }
  const activeExists = state.changelists.some((cl) => cl.id === state.activeId);
  if (!activeExists) {
    state.activeId = DEFAULT_CL_ID;
  }
  // Dedupe across changelists: first changelist containing a path wins.
  const seen = new Set<string>();
  for (const cl of state.changelists) {
    cl.files = cl.files.filter((f) => {
      const key = keyFor(f);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  return state;
}

export function findById(state: ChangelistsState, id: string): Changelist | undefined {
  return state.changelists.find((cl) => cl.id === id);
}

/** The changelist containing `path`, if any. */
export function findForPath(state: ChangelistsState, path: string): Changelist | undefined {
  const key = keyFor(path);
  return state.changelists.find((cl) => cl.files.some((f) => keyFor(f) === key));
}

export function create(state: ChangelistsState, name: string, opts?: { comment?: string; makeActive?: boolean }): ChangelistsState {
  const cl: Changelist = {
    id: `cl-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    name,
    files: [],
  };
  if (opts?.comment) {
    cl.comment = opts.comment;
  }
  const next = { ...state, changelists: [...state.changelists, cl] };
  if (opts?.makeActive) {
    next.activeId = cl.id;
  }
  return next;
}

export function rename(state: ChangelistsState, id: string, name: string): ChangelistsState {
  return {
    ...state,
    changelists: state.changelists.map((cl) => (cl.id === id ? { ...cl, name } : cl)),
  };
}

export function editComment(state: ChangelistsState, id: string, comment?: string): ChangelistsState {
  return {
    ...state,
    changelists: state.changelists.map((cl) =>
      cl.id === id ? { ...cl, comment: comment && comment.length > 0 ? comment : undefined } : cl,
    ),
  };
}

export function setActive(state: ChangelistsState, id: string): ChangelistsState {
  if (!findById(state, id)) {
    return state;
  }
  return { ...state, activeId: id };
}

/**
 * Deletes a changelist; its members fall back to the active one. The default
 * changelist cannot be deleted.
 */
export function remove(state: ChangelistsState, id: string): ChangelistsState {
  if (id === DEFAULT_CL_ID || !findById(state, id)) {
    return state;
  }
  const orphan = findById(state, id);
  if (!orphan) {
    return state;
  }
  const target = state.activeId === id ? DEFAULT_CL_ID : state.activeId;
  const next: ChangelistsState = {
    ...state,
    changelists: state.changelists
      .filter((cl) => cl.id !== id)
      .map((cl) => {
        if (cl.id !== target) {
          return cl;
        }
        const merged = new Map<string, string>();
        for (const f of [...cl.files, ...orphan.files]) {
          merged.set(keyFor(f), f);
        }
        return { ...cl, files: [...merged.values()] };
      }),
  };
  if (next.activeId === id) {
    next.activeId = target;
  }
  return next;
}

/** Moves files into one changelist, removing them from every other. */
export function moveFiles(state: ChangelistsState, paths: readonly string[], targetId: string): ChangelistsState {
  if (!findById(state, targetId)) {
    return state;
  }
  const keys = new Set(paths.map((p) => keyFor(p)));
  const nextChangelists = state.changelists.map((cl) => {
    const without = cl.files.filter((f) => !keys.has(keyFor(f)));
    if (cl.id !== targetId) {
      return without.length === cl.files.length ? cl : { ...cl, files: without };
    }
    const merged = new Map<string, string>();
    for (const f of without) {
      merged.set(keyFor(f), f);
    }
    for (const p of paths) {
      merged.set(keyFor(p), p);
    }
    return { ...cl, files: [...merged.values()] };
  });
  return { ...state, changelists: nextChangelists };
}

/**
 * Reconcile against the current git status:
 *  - paths that left the status (committed/deleted) are dropped everywhere;
 *  - new paths are assigned to the active changelist when `autoAssign`.
 */
export function reconcile(state: ChangelistsState, currentPaths: readonly string[], opts: { autoAssign: boolean }): ChangelistsState {
  const current = new Set(currentPaths.map((p) => keyFor(p)));
  const known = new Set<string>();
  for (const cl of state.changelists) {
    for (const f of cl.files) {
      known.add(keyFor(f));
    }
  }
  let next: ChangelistsState = state;
  // Drop gone paths.
  next = {
    ...next,
    changelists: next.changelists.map((cl) => {
      const filtered = cl.files.filter((f) => current.has(keyFor(f)));
      return filtered.length === cl.files.length ? cl : { ...cl, files: filtered };
    }),
  };
  // Assign new paths to the active changelist.
  if (opts.autoAssign) {
    const newPaths = currentPaths.filter((p) => {
      const key = keyFor(p);
      return !known.has(key) && current.has(key);
    });
    if (newPaths.length > 0) {
      next = moveFiles(next, newPaths, next.activeId);
    }
  }
  return next;
}

/** Members of a changelist that currently have changes in the working tree/status. */
export function membersWithChanges(state: ChangelistsState, id: string, currentPaths: readonly string[]): string[] {
  const current = new Set(currentPaths.map((p) => keyFor(p)));
  const cl = findById(state, id);
  if (!cl) {
    return [];
  }
  return cl.files.filter((f) => current.has(keyFor(f)));
}
