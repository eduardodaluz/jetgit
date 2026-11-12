/**
 * In-memory commit selection for the changelists tree (IntelliJ parity):
 * each file's checkbox decides whether it joins the next commit of its
 * changelist. Absent from the unchecked set = checked, so files that arrive
 * via auto-assign start CHECKED (IntelliJ behavior) and the default state is
 * everything checked. Ephemeral by design — a session intent, not metadata.
 *
 * Pure module, no vscode import (vitest rule).
 */

const key = (repoKey: string, changelistId: string): string => `${repoKey}\0${changelistId}`;

export class CommitSelection {
  private readonly unchecked = new Map<string, Set<string>>();

  isChecked(repoKey: string, changelistId: string, relPath: string): boolean {
    return !this.unchecked.get(key(repoKey, changelistId))?.has(relPath);
  }

  setChecked(repoKey: string, changelistId: string, relPath: string, checked: boolean): void {
    const k = key(repoKey, changelistId);
    if (checked) {
      this.unchecked.get(k)?.delete(relPath);
      return;
    }
    let set = this.unchecked.get(k);
    if (!set) {
      set = new Set<string>();
      this.unchecked.set(k, set);
    }
    set.add(relPath);
  }

  checkAll(repoKey: string, changelistId: string): void {
    this.unchecked.delete(key(repoKey, changelistId));
  }

  uncheckAll(repoKey: string, changelistId: string, files: readonly string[]): void {
    this.checkAll(repoKey, changelistId);
    if (files.length > 0) {
      this.unchecked.set(key(repoKey, changelistId), new Set(files));
    }
  }

  /** The members that would join a commit right now. */
  checkedSubset(repoKey: string, changelistId: string, files: readonly string[]): string[] {
    return files.filter((f) => this.isChecked(repoKey, changelistId, f));
  }

  /**
   * Reconcile-time hygiene: unchecked entries for paths that left the
   * changelist (or changelists that no longer exist) are dropped so state
   * never goes stale. Pass the CURRENT changelist inventory of the repo.
   */
  pruneRepo(repoKey: string, changelists: ReadonlyArray<{ id: string; files: readonly string[] }>): void {
    const live = new Set(changelists.map((c) => key(repoKey, c.id)));
    for (const k of [...this.unchecked.keys()]) {
      if (k.startsWith(`${repoKey}\0`) && !live.has(k)) {
        this.unchecked.delete(k);
      }
    }
    for (const cl of changelists) {
      const set = this.unchecked.get(key(repoKey, cl.id));
      if (set) {
        const memberKeys = new Set(cl.files);
        for (const relPath of [...set]) {
          if (!memberKeys.has(relPath)) {
            set.delete(relPath);
          }
        }
        if (set.size === 0) {
          this.unchecked.delete(key(repoKey, cl.id));
        }
      }
    }
  }
}
