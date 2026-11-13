/**
 * ChangelistsController: owns one ChangelistsService per repository and
 * registers every `jetgit.changelists.*` command. Tree node arguments carry
 * repoKey + ids, so commands work from any window with any repo focused.
 */
import * as vscode from 'vscode';
import { DisposableCollection } from '../common/async';
import { showError } from '../common/log';
import type { GitApiService, RepoHandle } from '../git/gitApi';
import { Strings } from '../strings';
import type { ChangesReviewController } from '../changes/review';
import * as model from './model';
import { CommitSelection } from './selection';
import { ChangelistsService } from './service';
import type { ChangelistFileNode, ChangelistNode, JetGitChangelistsTreeNode } from './tree';

export class ChangelistsController {
  private readonly services = new Map<string, ChangelistsService>();
  private readonly selection = new CommitSelection();
  private readonly disposables = new DisposableCollection();
  private readonly reposListener: vscode.Disposable;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private review: ChangesReviewController | undefined;

  /** Fires whenever any per-repo service's changelist state changes. */
  readonly onDidChangeServices = this.changeEmitter.event;

  constructor(private readonly gitApi: GitApiService) {
    this.reposListener = gitApi.onDidChangeRepos(() => void this.syncRepos());
    this.disposables.add(this.reposListener);
    void this.syncRepos();
  }

  /** Snapshot of live repo+service pairs (drives the tree provider). */
  entries(): Array<{ repo: RepoHandle; service: ChangelistsService }> {
    const out: Array<{ repo: RepoHandle; service: ChangelistsService }> = [];
    for (const [key, service] of this.services) {
      const repo = this.gitApi.repositories.find((r) => r.rootUri.toString() === key);
      if (repo) {
        out.push({ repo, service });
      }
    }
    return out;
  }

  /** Injects the M6.7 review controller (hunk sessions + partial commits). */
  attachReview(review: ChangesReviewController): void {
    this.review = review;
  }

  /** Whole-file checkbox state — the review controller's seeding source. */
  isTreeChecked(repoKey: string, relPath: string): boolean {
    const state = this.serviceFor(repoKey)?.snapshot;
    if (!state) {
      return false;
    }
    const cl = model.findForPath(state, relPath);
    return cl ? this.selection.isChecked(repoKey, cl.id, relPath) : false;
  }

  /** Tree rendering callbacks: joining = session-partial OR tree-checked. */
  isJoining(repoKey: string, changelistId: string, relPath: string): boolean {
    if (this.review?.isJoining(repoKey, relPath)) {
      return true;
    }
    return this.selection.isChecked(repoKey, changelistId, relPath);
  }

  partialLabel(repoKey: string, changelistId: string, relPath: string): string | undefined {
    return this.review?.partialLabel(repoKey, relPath);
  }

  /** Checkbox state source for the tree (file + changelist nodes). */
  isChecked(repoKey: string, changelistId: string, relPath: string): boolean {
    return this.selection.isChecked(repoKey, changelistId, relPath);
  }

  /**
   * TreeView checkbox toggles. File rows flip one path; a changelist row
   * applies to all its current members (the VS Code checkbox has no visual
   * mixed state, so it reads checked only when EVERYTHING is checked —
   * clicking a partially-checked changelist checks all).
   */
  handleCheckboxChange(event: vscode.TreeCheckboxChangeEvent<JetGitChangelistsTreeNode>): void {
    let changed = false;
    for (const [element, state] of event.items) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      if ((element as ChangelistFileNode).kind === 'changelistFile') {
        const node = element as ChangelistFileNode;
        // The tree answers "whole file?": a click always folds the hunk session.
        this.review?.clearSessions(node.repoKey, [node.relPath]);
        this.selection.setChecked(node.repoKey, node.changelistId, node.relPath, checked);
        changed = true;
      } else if ((element as ChangelistNode).kind === 'changelist') {
        const node = element as ChangelistNode;
        const files = this.serviceFor(node.repoKey)?.snapshot?.changelists.find((c) => c.id === node.changelistId)?.files ?? [];
        this.review?.clearSessions(node.repoKey, files);
        if (checked) {
          this.selection.checkAll(node.repoKey, node.changelistId, files);
        } else {
          this.selection.uncheckAll(node.repoKey, node.changelistId);
        }
        changed = true;
      }
    }
    if (changed) {
      this.changeEmitter.fire();
    }
  }

  /** Drops unchecked entries for paths/changelists that no longer exist. */
  private pruneSelection(repoKey: string): void {
    const state = this.serviceFor(repoKey)?.snapshot;
    if (state) {
      this.selection.pruneRepo(
        repoKey,
        state.changelists.map((c) => ({ id: c.id, files: c.files })),
      );
    }
  }

  private async syncRepos(): Promise<void> {
    const liveKeys = new Set<string>();
    for (const repo of this.gitApi.repositories) {
      const key = repo.rootUri.toString();
      liveKeys.add(key);
      if (!this.services.has(key)) {
        try {
          const gitDir = await this.gitApi.ensureGitDir(repo);
          const service = new ChangelistsService(repo, gitDir || '');
          service.setPartialCommitRunner((repoHandle, members, partial, message) =>
            this.review ? this.review.runPartialCommit(repoHandle, members, partial, message) : Promise.resolve(false),
          );
          await service.ready();
          await service.reconcile();
          this.services.set(key, service);
          this.disposables.add(
            service.onDidChange(() => {
              this.pruneSelection(key);
              this.review?.pruneRepo(key, new Set(service.currentStatusPaths()));
              this.changeEmitter.fire();
            }),
          );
          this.changeEmitter.fire();
        } catch (err) {
          showError(`JetGit: failed to attach to repository ${repo.rootUri.fsPath}`, err);
        }
      }
    }
    for (const [key, service] of [...this.services]) {
      if (!liveKeys.has(key)) {
        service.dispose();
        this.services.delete(key);
      }
    }
  }

  private serviceFor(repoKey: string): ChangelistsService | undefined {
    return this.services.get(repoKey);
  }

  private async withService(repoKey: string, fn: (service: ChangelistsService) => Promise<void>): Promise<void> {
    const service = this.serviceFor(repoKey);
    if (!service) {
      return;
    }
    try {
      await fn(service);
    } catch (err) {
      showError(Strings.changelists.commitFailed, err);
    }
  }

  registerCommands(): vscode.Disposable {
    const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
      this.disposables.add(vscode.commands.registerCommand(command, handler));
    };

    register('jetgit.changelists.new', async () => {
      const entry = await this.pickRepo();
      if (!entry) {
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: Strings.changelists.newChangelistPrompt, ignoreFocusOut: true });
      if (!name || name.trim().length === 0) {
        return;
      }
      await this.withService(entry.repo.rootUri.toString(), async (service) => {
        await service.mutate((state) => model.create(state, name.trim()));
      });
    });

    register('jetgit.changelists.rename', async (node: unknown) => {
      if (!isChangelistNode(node)) {
        return;
      }
      const service = this.serviceFor(node.repoKey);
      const current = service?.snapshot?.changelists.find((c) => c.id === node.changelistId);
      const name = await vscode.window.showInputBox({
        prompt: Strings.changelists.renamePrompt,
        value: current?.name,
        ignoreFocusOut: true,
      });
      if (!name || name.trim().length === 0) {
        return;
      }
      await this.withService(node.repoKey, (service2) => service2.mutate((state) => model.rename(state, node.changelistId, name.trim())));
    });

    register('jetgit.changelists.editComment', async (node: unknown) => {
      if (!isChangelistNode(node)) {
        return;
      }
      const service = this.serviceFor(node.repoKey);
      const current = service?.snapshot?.changelists.find((c) => c.id === node.changelistId);
      const comment = await vscode.window.showInputBox({
        prompt: Strings.changelists.commentPrompt,
        value: current?.comment ?? '',
        ignoreFocusOut: true,
      });
      if (comment === undefined) {
        return;
      }
      await this.withService(node.repoKey, (service2) =>
        service2.mutate((state) => model.editComment(state, node.changelistId, comment.trim())),
      );
    });

    register('jetgit.changelists.delete', async (node: unknown) => {
      if (!isChangelistNode(node)) {
        return;
      }
      if (node.changelistId === model.DEFAULT_CL_ID) {
        return; // the default changelist cannot be deleted
      }
      const service = this.serviceFor(node.repoKey);
      const name = service?.snapshot?.changelists.find((c) => c.id === node.changelistId)?.name ?? node.changelistId;
      const activeName = service?.snapshot?.changelists.find((c) => c.id === service.snapshot?.activeId)?.name ?? Strings.changelists.defaultName;
      const confirm = await vscode.window.showWarningMessage(
        Strings.changelists.deleteConfirm.replace('{name}', name).replace('{active}', activeName),
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') {
        return;
      }
      await this.withService(node.repoKey, (service2) => service2.mutate((state) => model.remove(state, node.changelistId)));
    });

    register('jetgit.changelists.setActive', async (node: unknown) => {
      if (!isChangelistNode(node)) {
        return;
      }
      await this.withService(node.repoKey, (service) => service.mutate((state) => model.setActive(state, node.changelistId)));
    });

    register('jetgit.changelists.moveFiles', async (node: unknown, nodes: unknown) => {
      const allNodes = [node, ...(Array.isArray(nodes) ? nodes : [])];
      const fileNodes = allNodes.filter(isFileNode);
      const first = fileNodes[0];
      if (!first) {
        return;
      }
      const repoKey = first.repoKey;
      const service = this.serviceFor(repoKey);
      const state = service?.snapshot;
      if (!service || !state) {
        return;
      }
      const targetId = await vscode.window.showQuickPick(
        state.changelists
          .filter((c) => c.id !== first.changelistId)
          .map((c) => ({ label: c.name, description: c.comment, id: c.id })),
        { placeHolder: Strings.changelists.movePrompt },
      );
      if (!targetId) {
        return;
      }
      const paths = fileNodes.filter((f) => f.repoKey === repoKey).map((f) => f.relPath);
      await this.withService(repoKey, (service2) => service2.mutate((state2) => model.moveFiles(state2, paths, targetId.id)));
    });

    register('jetgit.changelists.moveFilesInternal', async (paths: unknown, repoKey: unknown, targetId: unknown) => {
      if (!Array.isArray(paths) || typeof repoKey !== 'string' || typeof targetId !== 'string') {
        return;
      }
      await this.withService(repoKey, (service) => service.mutate((state) => model.moveFiles(state, paths as string[], targetId)));
    });

    register('jetgit.changelists.commit', async (node: unknown) => {
      if (!isChangelistNode(node)) {
        return;
      }
      // The joining subset drives the commit (IntelliJ parity): whole-checked
      // files plus partial hunk sessions. Nothing joining → the service's
      // "no changes" info.
      const files =
        this.serviceFor(node.repoKey)?.snapshot?.changelists.find((c) => c.id === node.changelistId)?.files ?? [];
      const joining = files.filter((f) => this.isJoining(node.repoKey, node.changelistId, f));
      const partial = this.review?.partialPlanFor(node.repoKey, joining) ?? new Map();
      await this.withService(node.repoKey, (service) => service.commitChangelist(node.changelistId, new Set(joining), partial));
    });

    register('jetgit.changelists.commitFiles', async (node: unknown, nodes: unknown) => {
      const fileNodes = [node, ...(Array.isArray(nodes) ? nodes : [])].filter(isFileNode);
      const first = fileNodes[0];
      if (!first) {
        return;
      }
      // Explicit selection forces inclusion; files with review sessions still
      // contribute their included hunks (single mental model, IntelliJ parity).
      // Multi-select spanning changelists commits the first changelist's files.
      const paths = [
        ...new Set(
          fileNodes.filter((f) => f.repoKey === first.repoKey && f.changelistId === first.changelistId).map((f) => f.relPath),
        ),
      ];
      if (paths.length === 0) {
        return;
      }
      const partial = this.review?.partialPlanFor(first.repoKey, paths) ?? new Map();
      await this.withService(first.repoKey, (service) => service.commitChangelist(first.changelistId, new Set(paths), partial));
    });

    register('jetgit.changelists.refresh', async () => {
      // Force a status reconcile across repositories (RepoStatePoller keeps
      // things live; this is the explicit IntelliJ-style Refresh).
      for (const entry of this.entries()) {
        await this.withService(entry.repo.rootUri.toString(), (service) => service.reconcile());
      }
      this.changeEmitter.fire();
    });

    register('jetgit.changelists.removeEmpty', async () => {
      const entry = await this.pickRepo();
      if (!entry) {
        return;
      }
      await this.withService(entry.repo.rootUri.toString(), async (service) => {
        const state = service.snapshot;
        if (!state) {
          return;
        }
        await service.mutate((s) => {
          let next = s;
          for (const cl of [...state.changelists]) {
            if (cl.files.length === 0 && cl.id !== model.DEFAULT_CL_ID) {
              next = model.remove(next, cl.id);
            }
          }
          return next;
        });
      });
    });

    return this.disposables;
  }

  private async pickRepo(): Promise<{ repo: RepoHandle } | undefined> {
    const entries = this.entries();
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(Strings.gitAvailability.noRepositories);
      return undefined;
    }
    const first = entries[0];
    if (entries.length === 1 && first) {
      return { repo: first.repo };
    }
    // Multi-root: let the user pick the repository.
    const repos = entries.map((e) => e.repo);
    const quickPick = vscode.window.createQuickPick();
    quickPick.items = repos.map((repo) => ({ label: repo.rootUri.fsPath }));
    quickPick.placeholder = Strings.changelists.pickRepoPrompt;
    return new Promise<{ repo: RepoHandle } | undefined>((resolve) => {
      quickPick.onDidHide(() => resolve(undefined));
      quickPick.onDidChangeSelection((selection) => {
        const picked = selection[0];
        if (picked) {
          const repo = repos.find((r) => r.rootUri.fsPath === picked.label);
          quickPick.hide();
          resolve(repo ? { repo } : undefined);
        }
      });
      quickPick.show();
    });
  }

  dispose(): void {
    this.disposables.dispose();
    this.changeEmitter.dispose();
    for (const service of this.services.values()) {
      service.dispose();
    }
    this.services.clear();
  }
}

export function isChangelistNode(node: unknown): node is { repoKey: string; changelistId: string } {
  return typeof node === 'object' && node !== null && 'repoKey' in node && 'changelistId' in node;
}

function isFileNode(node: unknown): node is { repoKey: string; changelistId: string; relPath: string } {
  return (
    typeof node === 'object' && node !== null && 'repoKey' in node && 'changelistId' in node && 'relPath' in node
  );
}
