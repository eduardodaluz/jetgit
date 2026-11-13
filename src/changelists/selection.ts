/**
 * In-memory commit selection for the changelists tree (IntelliJ parity):
 * each file's checkbox decides whether it joins the next commit of its
 * changelist. Present in the checked set = checked, so the default state is
 * EVERYTHING UNCHECKED (the user marks what joins, per IntelliJ's commit
 * list). Files arriving via auto-assign start unchecked too. Ephemeral by
 * design — a session intent, not metadata.
 *
 * Pure module, no vscode import (vitest rule).
 */

const key = (repoKey: string, changelistId: string): string => `${repoKey}\0${changelistId}`;

export class CommitSelection {
  private readonly checked = new Map<string, Set<string>>();

  isChecked(repoKey: string, changelistId: string, relPath: string): boolean {
    return this.checked.get(key(repoKey, changelistId))?.has(relPath) ?? false;
  }

  setChecked(repoKey: string, changelistId: string, relPath: string, checked: boolean): void {
    const k = key(repoKey, changelistId);
    if (checked) {
      let set = this.checked.get(k);
      if (!set) {
        set = new Set<string>();
        this.checked.set(k, set);
      }
      set.add(relPath);
      return;
    }
    this.checked.get(k)?.delete(relPath);
  }

  checkAll(repoKey: string, changelistId: string, files: readonly string[]): void {
    if (files.length === 0) {
      this.checked.delete(key(repoKey, changelistId));
      return;
    }
    this.checked.set(key(repoKey, changelistId), new Set(files));
  }

  uncheckAll(repoKey: string, changelistId: string): void {
    this.checked.delete(key(repoKey, changelistId));
  }

  /** The members that would join a commit right now. */
  checkedSubset(repoKey: string, changelistId: string, files: readonly string[]): string[] {
    return files.filter((f) => this.isChecked(repoKey, changelistId, f));
  }

  /**
   * Reconcile-time hygiene: checked entries for paths that left the
   * changelist (or changelists that no longer exist) are dropped so state
   * never goes stale. Pass the CURRENT changelist inventory of the repo.
   */
  pruneRepo(repoKey: string, changelists: ReadonlyArray<{ id: string; files: readonly string[] }>): void {
    const live = new Set(changelists.map((c) => key(repoKey, c.id)));
    for (const k of [...this.checked.keys()]) {
      if (k.startsWith(`${repoKey}\0`) && !live.has(k)) {
        this.checked.delete(k);
      }
    }
    for (const cl of changelists) {
      const set = this.checked.get(key(repoKey, cl.id));
      if (set) {
        const memberKeys = new Set(cl.files);
        for (const relPath of [...set]) {
          if (!memberKeys.has(relPath)) {
            set.delete(relPath);
          }
        }
        if (set.size === 0) {
          this.checked.delete(key(repoKey, cl.id));
        }
      }
    }
  }
}
