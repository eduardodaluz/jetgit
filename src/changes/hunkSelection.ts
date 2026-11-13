/**
 * Per-file review sessions backing the diff-editor hunk checkboxes (M6.7,
 * IntelliJ "include lines into commit"). A session records WHICH changed
 * hunks of a file join the next commit; it persists independently of open
 * editors — the user can close the diff and commit from the tree — and is
 * pruned by reconcile, folded by tree-checkbox clicks, cleared after commit.
 *
 * Hunk identity = content signature (fnv1a32 over the hunk's changed lines)
 * plus an ordinal that disambiguates identical adjacent hunks. Line numbers
 * are deliberately excluded: an upstream insertion shifts every newStart,
 * which would stale-out an entire selection; a content+ordinal signature
 * survives pure line shifts. Signatures that no longer match the fresh diff
 * are dropped from the effective set at commit time — edits made AFTER the
 * review are never committed (conservative, safe direction).
 *
 * Pure module, no vscode import (vitest rule).
 */

/** Stable key: repoKey (rootUri string) + NUL + repo-relative path. */
export const reviewKey = (repoKey: string, relPath: string): string => `${repoKey}\0${relPath}`;

export interface ReviewSession {
  /** Current file's hunk signatures, in diff order (refreshed on change). */
  signatures: readonly string[];
  /** User intent: signatures the user wants in the commit. */
  included: Set<string>;
}

/** FNV-1a 32-bit over a string, hex-encoded — deterministic, no imports. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface SigSource {
  readonly oldCount: number;
  readonly newCount: number;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
}

/**
 * Signature for the hunk at `index` among hunks with an identical base
 * signature; the ordinal (nth earlier duplicate) keeps two identical adjacent
 * edits distinguishable and is stable under upstream shifts.
 */
export function hunkSignature(hunks: readonly SigSource[], index: number): string {
  const hunk = hunks[index];
  if (!hunk) {
    return '';
  }
  const base = fnv1a32(`${hunk.oldCount}:${hunk.newCount}:${hunk.oldLines.join('\n')}:${hunk.newLines.join('\n')}`);
  let ordinal = 0;
  for (let i = 0; i < index; i++) {
    const other = hunks[i];
    if (!other) {
      continue;
    }
    if (
      fnv1a32(`${other.oldCount}:${other.newCount}:${other.oldLines.join('\n')}:${other.newLines.join('\n')}`) === base
    ) {
      ordinal++;
    }
  }
  return `${base}#${ordinal}`;
}

/** All signatures for a diff, in hunk order. */
export function allSignatures(hunks: readonly SigSource[]): string[] {
  return hunks.map((_, index) => hunkSignature(hunks, index));
}

/** User intent ∩ current signatures — stale entries silently drop out. */
export function effectiveSignatures(session: ReviewSession): string[] {
  return session.signatures.filter((sig) => session.included.has(sig));
}

/** Whether a file joins the next commit, and how. */
export type EntryState = 'partial' | 'whole' | 'excluded';

export function entryState(state: { hasSession: boolean; effectiveCount: number; treeChecked: boolean }): EntryState {
  if (state.hasSession && state.effectiveCount > 0) {
    return 'partial';
  }
  return state.treeChecked ? 'whole' : 'excluded';
}

export type ToggleOutcome = 'included' | 'excluded' | 'folded-whole' | 'folded-excluded';

export class HunkSelectionStore {
  private readonly sessions = new Map<string, ReviewSession>();

  /** Called after every mutation (the controller wires it to its event). */
  changeListener: (() => void) | undefined;

  session(repoKey: string, relPath: string): ReviewSession | undefined {
    return this.sessions.get(reviewKey(repoKey, relPath));
  }

  isPartial(repoKey: string, relPath: string): boolean {
    const session = this.session(repoKey, relPath);
    return session !== undefined && effectiveSignatures(session).length > 0;
  }

  openSession(repoKey: string, relPath: string, signatures: readonly string[]): ReviewSession {
    const k = reviewKey(repoKey, relPath);
    let session = this.sessions.get(k);
    if (session) {
      // Refresh what the file looks like now; keep the user's intent.
      session.signatures = [...signatures];
    } else {
      session = { signatures: [...signatures], included: new Set() };
      this.sessions.set(k, session);
    }
    this.notify();
    return session;
  }

  refreshSignatures(repoKey: string, relPath: string, signatures: readonly string[]): void {
    const session = this.sessions.get(reviewKey(repoKey, relPath));
    if (!session) {
      return;
    }
    session.signatures = [...signatures];
    this.notify();
  }

  closeSession(repoKey: string, relPath: string): void {
    if (this.sessions.delete(reviewKey(repoKey, relPath))) {
      this.notify();
    }
  }

  /**
   * Toggles one hunk. Seeding keeps IntelliJ parity with OUR default-unchecked
   * files: toggling OFF a hunk of a tree-checked (whole) file leaves the rest
   * included (all-minus-one); toggling ON a hunk of an unchecked file starts
   * from {that hunk}. Folding: reaching ALL signatures folds to WHOLE (session
   * closed, file tree-checked); reaching zero folds to EXCLUDED.
   */
  toggle(
    repoKey: string,
    relPath: string,
    index: number,
    seedAll: boolean,
  ): ToggleOutcome {
    const k = reviewKey(repoKey, relPath);
    const session = this.sessions.get(k);
    if (!session) {
      return 'excluded';
    }
    const sig = session.signatures[index];
    if (!sig) {
      return 'excluded';
    }
    if (session.included.size === 0) {
      // Seed from the tree state on the first meaningful toggle.
      if (seedAll) {
        for (const s of session.signatures) {
          session.included.add(s);
        }
        session.included.delete(sig);
      } else {
        session.included.add(sig);
      }
    } else if (session.included.has(sig)) {
      session.included.delete(sig);
    } else {
      session.included.add(sig);
    }

    const effective = effectiveSignatures(session);
    if (session.signatures.length > 0 && effective.length === session.signatures.length) {
      this.sessions.delete(k);
      this.notify();
      return 'folded-whole';
    }
    if (effective.length === 0) {
      this.sessions.delete(k);
      this.notify();
      return 'folded-excluded';
    }
    this.notify();
    return session.included.has(sig) ? 'included' : 'excluded';
  }

  /** Total vs effective signature counts for the tree's "i/n hunks" label. */
  counts(repoKey: string, relPath: string): { included: number; total: number } | undefined {
    const session = this.session(repoKey, relPath);
    if (!session) {
      return undefined;
    }
    return { included: effectiveSignatures(session).length, total: session.signatures.length };
  }

  pruneRepo(repoKey: string, liveRelPaths: ReadonlySet<string>): void {
    const prefix = `${repoKey}\0`;
    for (const k of [...this.sessions.keys()]) {
      if (k.startsWith(prefix) && !liveRelPaths.has(k.slice(prefix.length))) {
        this.sessions.delete(k);
        this.notify();
      }
    }
  }

  private notify(): void {
    this.changeListener?.();
  }
}
