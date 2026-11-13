/**
 * Per-repository changelists service: status reconciliation (auto-assign new
 * paths to the active changelist, drop paths that left the status) and the
 * commit-a-changelist algorithm.
 *
 * Commit safety model (plan §commit-a-changelist): `git commit --only`
 * commits a temporary index built from HEAD + the pathspec's working-tree
 * content — the user's real index is only touched for pathspec paths, so
 * non-member staged entries survive untouched. The only index mutation we
 * make is `git add -f` for untracked members, rolled back exactly on failure.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { debounce, delay } from '../common/async';
import { showError } from '../common/log';
import { settings } from '../common/settingsInstance';
import { keyFor, toRepoRel } from '../common/paths';
import { TempTextFile, pathspecArgs, withPathspecFiles } from '../git/gitCli';
import type { RepoHandle } from '../git/gitApi';
import { Strings } from '../strings';
import * as model from './model';
import type { PartialPlan } from '../changes/partialCommit';
import { ChangelistsStore } from './store';

/** Runs the M6.7 temp-index partial commit; wired by the changelists controller. */
export type PartialCommitRunner = (
  repo: RepoHandle,
  members: readonly string[],
  partial: PartialPlan,
  message: string,
) => Promise<boolean>;

export class ChangelistsService {
  private state: model.ChangelistsState | undefined;
  private readonly store: ChangelistsStore;
  private readonly stateListener: vscode.Disposable;
  private readonly reconcileDebounced: ((...args: []) => void) & { cancel(): void };
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private commitInProgress = false;
  private partialRunner: PartialCommitRunner | undefined;

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly repo: RepoHandle,
    gitDir: string,
  ) {
    this.store = new ChangelistsStore(gitDir);
    this.reconcileDebounced = debounce(() => void this.reconcile(), 300);
    this.stateListener = repo.onDidChangeState(() => {
      if (!this.commitInProgress) {
        this.reconcileDebounced();
      }
    });
  }

  async ready(): Promise<void> {
    this.state = await this.store.get();
    this.changeEmitter.fire();
  }

  get snapshot(): model.ChangelistsState | undefined {
    return this.state;
  }

  /** Injects the review feature's temp-index commit runner (M6.7 wiring). */
  setPartialCommitRunner(runner: PartialCommitRunner | undefined): void {
    this.partialRunner = runner;
  }

  /** All repo-relative paths currently present in git status. */
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

  async mutate(fn: (state: model.ChangelistsState) => model.ChangelistsState): Promise<void> {
    if (!this.state) {
      await this.ready();
    }
    if (!this.state) {
      return;
    }
    this.state = model.ensureInvariants(fn(this.state));
    this.store.set(this.state);
    this.changeEmitter.fire();
  }

  /** Applies reconcile against live status and persists only real changes. */
  async reconcile(): Promise<void> {
    if (this.commitInProgress) {
      return;
    }
    if (!this.state) {
      await this.ready();
    }
    if (!this.state) {
      return;
    }
    const before = JSON.stringify(this.state);
    const next = model.reconcile(this.state, this.currentStatusPaths(), {
      autoAssign: settings().value.changelists.autoAssign,
    });
    const after = JSON.stringify(next);
    if (before !== after) {
      this.state = next;
      this.store.set(next);
      this.changeEmitter.fire();
    }
  }

  /**
   * Commits the changelist's members via `git commit --only`, preserving the
   * user's remaining index. Never passes --no-verify. `only` (the joining
   * subset) restricts the members; `partial` (hunk signatures per file)
   * routes the WHOLE commit through the M6.7 temp-index machinery instead.
   */
  async commitChangelist(id: string, only?: ReadonlySet<string>, partial?: PartialPlan): Promise<void> {
    if (!this.state) {
      await this.ready();
    }
    if (!this.state) {
      return;
    }
    const st = this.repo.api.state;
    const cl = model.findById(this.state, id);

    // (1) Partial commits are impossible mid-merge/revert/cherry-pick.
    const midOperation =
      st.mergeChanges.length > 0 ||
      (this.repo.gitDir !== '' &&
        ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD'].some((f) => fs.existsSync(path.join(this.repo.gitDir, f))));
    if (midOperation) {
      void vscode.window.showWarningMessage(Strings.changelists.commitPartialUnsupported);
      return;
    }

    let members = model.membersWithChanges(this.state, id, this.currentStatusPaths());
    if (only) {
      members = members.filter((m) => only.has(m));
    }
    const clName = cl?.name ?? id;
    if (members.length === 0) {
      void vscode.window.showInformationMessage(Strings.changelists.commitNoChanges.replace('{name}', clName));
      return;
    }

    // (2) Commit message: own InputBox, pre-filled with the changelist comment.
    const comment = cl?.comment ?? '';
    const message = await vscode.window.showInputBox({
      prompt: Strings.changelists.commitMessagePrompt,
      value: comment,
      valueSelection: comment.length > 0 ? [comment.length, comment.length] : undefined,
      ignoreFocusOut: true,
    });
    if (message === undefined || message.trim().length === 0) {
      return;
    }

    // M6.7 routing: any partial member switches to the temp-index commit —
    // the worktree and the real index are untouched until after success, so
    // the M2 untracked add/rollback dance is unnecessary on this path.
    if (partial && partial.size > 0 && this.partialRunner) {
      this.commitInProgress = true;
      try {
        const committed = await this.partialRunner(this.repo, members, partial, message);
        if (!committed) {
          void vscode.window.showInformationMessage(Strings.changelists.commitNoChanges.replace('{name}', clName));
          return;
        }
        void vscode.window.showInformationMessage(
          Strings.changelists.committedSummary.replace('{count}', members.length.toString()).replace('{name}', clName),
        );
      } catch (err) {
        await this.handleCommitError(err, clName, members);
        return;
      } finally {
        this.commitInProgress = false;
        await this.reconcile();
      }
      return;
    }

    // (3) Untracked members need `git add -f` before --only can include them.
    const untrackedKeys = new Set(
      st.untrackedChanges.map((c) => keyFor(toRepoRel(c.uri.fsPath, this.repo.rootUri.fsPath) ?? '')),
    );
    const untracked = members.filter((m) => untrackedKeys.has(keyFor(m)));

    this.commitInProgress = true;
    const msgFile = await TempTextFile.create(message);
    try {
      if (untracked.length > 0) {
        await withPathspecFiles([untracked], (ps) => this.repo.cli.runChecked(this.repo.rootUri.fsPath, ['add', '-f', ...pathspecArgs(ps)]));
      }
      try {
        await withPathspecFiles([members], (ps) =>
          this.repo.cli.run(this.repo.rootUri.fsPath, ['commit', '--only', `--file=${msgFile.path}`, ...pathspecArgs(ps)]),
        );
      } catch (err) {
        if (untracked.length > 0) {
          await this.rollbackUntracked(untracked);
        }
        await this.handleCommitError(err, clName, members);
        return;
      }

      // (4) Success: normalization guard (normally a no-op) + reconcile drop.
      await this.normalizeStagedMembers(members);
      void vscode.window.showInformationMessage(
        Strings.changelists.committedSummary.replace('{count}', members.length.toString()).replace('{name}', clName),
      );
    } finally {
      await msgFile.dispose();
      this.commitInProgress = false;
      await this.reconcile();
    }
  }

  /** Restores exact pre-commit untracked status after a failed commit. */
  private async rollbackUntracked(untracked: string[]): Promise<void> {
    try {
      await withPathspecFiles([untracked], (ps) => this.repo.cli.runChecked(this.repo.rootUri.fsPath, ['reset', '-q', ...pathspecArgs(ps)]));
    } catch (err) {
      showError('Could not restore untracked files after failed commit — check git status', err);
    }
  }

  /** Defensive: after a successful --only commit no member should remain staged. */
  private async normalizeStagedMembers(members: string[]): Promise<void> {
    try {
      const stdout = await withPathspecFiles([members], (ps) =>
        this.repo.cli.runReadOnlyChecked(this.repo.rootUri.fsPath, ['diff', '--cached', '--name-only', '-z', ...pathspecArgs(ps)]),
      );
      const stillStaged = stdout
        .toString('utf8')
        .split('\0')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (stillStaged.length > 0) {
        await withPathspecFiles([stillStaged], (ps) => this.repo.cli.runChecked(this.repo.rootUri.fsPath, ['reset', '-q', ...pathspecArgs(ps)]));
      }
    } catch {
      // Guard rail only — a failure here must not fail the (successful) commit flow.
    }
  }

  /** Maps git stderr to user-actionable messages. Never retries more than once. */
  private async handleCommitError(err: unknown, clName: string, members: string[]): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = message.toLowerCase();
    if (stderr.includes('nothing to commit')) {
      void vscode.window.showInformationMessage(Strings.changelists.commitNoChanges.replace('{name}', clName));
    } else if (stderr.includes('did not match')) {
      await this.reconcile();
      void vscode.window.showWarningMessage(
        Strings.changelists.commitPathspecChanged.replace('{count}', members.length.toString()),
      );
    } else if (stderr.includes('index.lock')) {
      await delay(1000);
      const choice = await vscode.window.showErrorMessage(
        `${Strings.changelists.commitFailed}: ${message}`,
        Strings.errors.showLog,
      );
      if (choice === Strings.errors.showLog) {
        vscode.commands.executeCommand('jetgit.showLog');
      }
    } else if (stderr.includes('gpg failed to sign')) {
      void vscode.window.showErrorMessage(Strings.changelists.commitGpgFailed);
    } else {
      await showError(Strings.changelists.commitFailed, err);
    }
  }

  dispose(): void {
    this.stateListener.dispose();
    this.reconcileDebounced.cancel();
    this.changeEmitter.dispose();
  }
}
