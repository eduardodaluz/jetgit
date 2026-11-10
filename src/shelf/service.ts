/**
 * Shelf service: patch-based shelves with IntelliJ semantics.
 *  - `git diff HEAD --binary` captures staged+unstaged+deleted state of
 *    tracked members in one segment;
 *  - untracked members get one `git diff --binary --no-index` segment each,
 *    invoked with REPO-RELATIVE paths so `git apply` can land them later;
 *  - apply runs PER FILE (each `diff --git` segment independently): exact
 *    per-file accounting and no risk of double-applying segments. `--3way`
 *    conflicts surface as standard working-tree conflicts → native merge
 *    editor.
 * Patch buffers are never text-decoded: binary patches survive byte-exact
 * and CRLF round-trips are delegated entirely to git.
 */
import * as vscode from 'vscode';
import { showError } from '../common/log';
import { keyFor, toRepoRel } from '../common/paths';
import { TempBufferFile } from '../git/gitCli';
import type { RepoHandle } from '../git/gitApi';
import { parsePatch } from './patchInfo';
import { buildShelfPatch, revertWorkingFiles, type GitDiffAdapter } from './patchBuilder';
import * as model from './model';
import { ShelfStore } from './store';
import { Strings } from '../strings';

export interface ApplyOutcome {
  /** Files applied cleanly. */
  applied: string[];
  /** Files whose apply ended in a conflict (markers + stages; resolvable in the merge editor). */
  conflicted: string[];
  /** Files whose apply failed structurally (patch/base mismatch). */
  failed: string[];
}

export class ShelfService {
  private readonly store: ShelfStore;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private busy = false;

  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly repo: RepoHandle, gitDir: string) {
    this.store = new ShelfStore(gitDir);
  }

  async listLive(): Promise<model.ShelfEntry[]> {
    return model.listLive(await this.store.get());
  }

  async listTrash(): Promise<model.ShelfEntry[]> {
    return model.listTrash(await this.store.get());
  }

  /**
   * Creates a shelf from explicit repo-relative paths. `revert: true`
   * restores working files (tracked → index version, untracked → removed);
   * `revert: false` = "Save to Shelf" (IntelliJ parity). The caller (commands
   * layer) resolves changelists into paths.
   */
  async shelve(paths: string[], name: string, opts: { revert: boolean }): Promise<model.ShelfEntry | undefined> {
    if (this.busy) {
      return undefined;
    }
    const statusPaths = this.currentStatusPaths();
    const allowed = new Set(statusPaths.map((p) => keyFor(p)));
    const members = paths.filter((p) => allowed.has(keyFor(p)));
    if (members.length === 0) {
      void vscode.window.showInformationMessage(Strings.shelf.nothingToShelve);
      return undefined;
    }

    const untracked = new Set(
      this.repo.api.state.untrackedChanges.map((c) => keyFor(toRepoRel(c.uri.fsPath, this.repo.rootUri.fsPath) ?? '')),
    );
    const tracked = members.filter((m) => !untracked.has(keyFor(m)));
    const untrackedMembers = members.filter((m) => untracked.has(keyFor(m)));

    this.busy = true;
    try {
      const patch = await buildShelfPatch(this.diffAdapter(), tracked, untrackedMembers);
      const parsed = parsePatch(patch);
      if (parsed.length === 0) {
        void vscode.window.showInformationMessage(Strings.shelf.nothingToShelve);
        return undefined;
      }

      const id = model.newEntryId();
      const bytes = await this.store.writePatch(id, patch);
      const entry: model.ShelfEntry = {
        id,
        name,
        createdAt: new Date().toISOString(),
        reverted: opts.revert,
        files: parsed.map((p) => p.path),
        bytes,
        untrackedCount: untrackedMembers.length,
        deletedAt: null,
      };
      await this.mutateIndex((index) => model.addEntry(index, entry));

      if (opts.revert) {
        await revertWorkingFiles(this.diffAdapter(), tracked, untrackedMembers);
      }
      this.changeEmitter.fire();
      return entry;
    } catch (err) {
      showError(Strings.shelf.shelveFailed, err);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  /** Adapter exposing the repo's git CLI through the patchBuilder contract. */
  private diffAdapter(): GitDiffAdapter {
    return {
      cwd: () => this.repo.rootUri.fsPath,
      runReadOnlyChecked: (args) => this.repo.cli.runReadOnlyChecked(this.repo.rootUri.fsPath, args),
      runReadOnly: (args) => this.repo.cli.runReadOnly(this.repo.rootUri.fsPath, args),
      runChecked: (args) => this.repo.cli.runChecked(this.repo.rootUri.fsPath, args),
    };
  }

  /**
   * Applies a shelf onto the working tree, per file.
   */
  async apply(id: string, opts?: { deleteAfter?: boolean }): Promise<ApplyOutcome | undefined> {
    const index = await this.store.get();
    const entry = model.findById(index, id);
    if (!entry || entry.deletedAt !== null) {
      return undefined;
    }
    const patch = await this.store.readPatch(entry);
    if (!patch) {
      void vscode.window.showErrorMessage(
        Strings.shelf.missingPatch.replace('{name}', entry.name),
      );
      return undefined;
    }

    this.busy = true;
    try {
      const outcome: ApplyOutcome = { applied: [], conflicted: [], failed: [] };
      for (const fileEntry of parsePatch(patch)) {
        const segment = patch.subarray(fileEntry.start, fileEntry.end);
        const result = await this.applySegment(segment);
        if (result === 'applied') {
          outcome.applied.push(fileEntry.path);
        } else if (result === 'conflict') {
          outcome.conflicted.push(fileEntry.path);
        } else {
          outcome.failed.push(fileEntry.path);
        }
      }
      await this.finishApply(entry, opts, outcome);
      return outcome;
    } finally {
      this.busy = false;
    }
  }

  /**
   * git apply exit codes: 0 = clean; 1 = conflict with --3way (markers +
   * index stages left for the merge editor — the content IS in the working
   * tree, so this counts as conflicted, not failed); anything else =
   * structural failure for that file only.
   */
  private async applySegment(segment: Buffer): Promise<'applied' | 'conflict' | 'failed'> {
    const tmp = await TempBufferFile.create(segment);
    try {
      const result = await this.repo.cli.run(this.repo.rootUri.fsPath, [
        'apply',
        '--3way',
        '--whitespace=nowarn',
        '--binary',
        tmp.path.replace(/\\/g, '/'),
      ]);
      if (result.code === 0) {
        return 'applied';
      }
      if (result.code === 1) {
        return 'conflict';
      }
      showError(Strings.shelf.applyFileFailed, new Error(result.stderr));
      return 'failed';
    } finally {
      await tmp.dispose();
    }
  }

  private async finishApply(entry: model.ShelfEntry, opts: { deleteAfter?: boolean } | undefined, outcome: ApplyOutcome): Promise<void> {
    if (opts?.deleteAfter && outcome.conflicted.length === 0 && outcome.failed.length === 0) {
      await this.trashById(entry.id);
    }
    const total = outcome.applied.length + outcome.conflicted.length + outcome.failed.length;
    if (outcome.conflicted.length > 0 || outcome.failed.length > 0) {
      const details: string[] = [];
      if (outcome.conflicted.length > 0) {
        details.push(`conflicted: ${outcome.conflicted.join(', ')}`);
      }
      if (outcome.failed.length > 0) {
        details.push(`failed: ${outcome.failed.join(', ')}`);
      }
      void vscode.window.showWarningMessage(
        Strings.shelf.applyPartial
          .replace('{name}', entry.name)
          .replace('{applied}', outcome.applied.length.toString())
          .replace('{total}', total.toString())
          .concat(` (${details.join('; ')})`),
        Strings.errors.showLog,
      ).then((choice) => {
        if (choice === Strings.errors.showLog) {
          vscode.commands.executeCommand('jetgit.showLog');
        }
      });
    } else {
      void vscode.window.showInformationMessage(
        Strings.shelf.appliedSummary.replace('{name}', entry.name).replace('{count}', outcome.applied.length.toString()),
      );
    }
    this.changeEmitter.fire();
  }

  async rename(id: string, name: string): Promise<void> {
    await this.mutateIndex((index) => model.rename(index, id, name));
    this.changeEmitter.fire();
  }

  /** Soft-delete: patch moves to .trash/, entry restorable. */
  async trashById(id: string): Promise<void> {
    await this.store.moveToTrash(id);
    await this.mutateIndex((index) => model.trash(index, id));
    this.changeEmitter.fire();
  }

  async restore(id: string): Promise<boolean> {
    const ok = await this.store.restoreFromTrash(id);
    if (!ok) {
      return false;
    }
    await this.mutateIndex((index) => model.restore(index, id));
    this.changeEmitter.fire();
    return true;
  }

  async missingPatch(entry: model.ShelfEntry): Promise<boolean> {
    return this.store.patchMissing(entry);
  }

  private async mutateIndex(fn: (index: model.ShelfIndex) => model.ShelfIndex): Promise<void> {
    const index = await this.store.get();
    this.store.set(fn(index));
  }

  /** All repo-relative paths currently present in git status ("All changes" scope). */
  currentStatusPaths(): string[] {
    const st = this.repo.api.state;
    const all = [...st.indexChanges, ...st.workingTreeChanges, ...st.untrackedChanges];
    const seen = new Map<string, string>();
    for (const change of all) {
      const rel = toRepoRel(change.uri.fsPath, this.repo.rootUri.fsPath);
      if (rel !== undefined) {
        seen.set(keyFor(rel), rel);
      }
    }
    return [...seen.values()];
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
