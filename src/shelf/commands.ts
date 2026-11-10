/**
 * ShelfController: owns one ShelfService per repository and registers the
 * `jetgit.shelf.*` commands. Shelve accepts an optional changelist node
 * (IntelliJ parity: shelve a whole changelist) or a QuickPick scope.
 */
import * as vscode from 'vscode';
import { DisposableCollection } from '../common/async';
import { showError } from '../common/log';
import { settings } from '../common/settingsInstance';
import type { GitApiService, RepoHandle } from '../git/gitApi';
import { Strings } from '../strings';
import { ChangelistsService } from '../changelists/service';
import { ShelfService } from './service';

export interface ChangelistPathsResolver {
  /** Live changelist services by repoKey (for scope resolution). */
  changelistEntries(): Array<{ repo: RepoHandle; service: ChangelistsService }>;
}

export class ShelfController {
  private readonly services = new Map<string, ShelfService>();
  private readonly disposables = new DisposableCollection();
  private readonly reposListener: vscode.Disposable;
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeServices = this.changeEmitter.event;

  constructor(
    private readonly gitApi: GitApiService,
    private readonly changelists: ChangelistPathsResolver,
  ) {
    this.reposListener = gitApi.onDidChangeRepos(() => void this.syncRepos());
    this.disposables.add(this.reposListener);
    void this.syncRepos();
  }

  entries(): Array<{ repo: RepoHandle; service: ShelfService }> {
    const out: Array<{ repo: RepoHandle; service: ShelfService }> = [];
    for (const [key, service] of this.services) {
      const repo = this.gitApi.repositories.find((r) => r.rootUri.toString() === key);
      if (repo) {
        out.push({ repo, service });
      }
    }
    return out;
  }

  private async syncRepos(): Promise<void> {
    const liveKeys = new Set<string>();
    for (const repo of this.gitApi.repositories) {
      const key = repo.rootUri.toString();
      liveKeys.add(key);
      if (!this.services.has(key)) {
        try {
          const gitDir = await this.gitApi.ensureGitDir(repo);
          const service = new ShelfService(repo, gitDir || '');
          this.services.set(key, service);
          this.disposables.add(service.onDidChange(() => this.changeEmitter.fire()));
          this.changeEmitter.fire();
        } catch (err) {
          showError(`JetGit: failed to attach shelf service to ${repo.rootUri.fsPath}`, err);
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

  private async resolveScopePaths(
    repoKey: string,
    changelistNode: unknown,
  ): Promise<{ paths: string[]; defaultName: string } | undefined> {
    // Explicit changelist node (context menu on the Changelists view).
    if (
      typeof changelistNode === 'object' &&
      changelistNode !== null &&
      'repoKey' in changelistNode &&
      'changelistId' in changelistNode
    ) {
      const node = changelistNode as { repoKey: string; changelistId: string };
      const clEntry = this.changelists.changelistEntries().find((e) => e.repo.rootUri.toString() === node.repoKey);
      const cl = clEntry?.service.snapshot?.changelists.find((c) => c.id === node.changelistId);
      if (clEntry && cl) {
        const statusPaths = clEntry.service.currentStatusPaths();
        const allowed = new Set(statusPaths.map((p) => p.toLowerCase()));
        return {
          paths: cl.files.filter((f) => allowed.has(f.toLowerCase())),
          defaultName: cl.name,
        };
      }
      return undefined;
    }

    // No node: QuickPick over live changelists + all changes.
    const repo = this.gitApi.repositories.find((r) => r.rootUri.toString() === repoKey);
    if (!repo) {
      return undefined;
    }
    const clEntry = this.changelists.changelistEntries().find((e) => e.repo.rootUri.toString() === repoKey);
    const state = clEntry?.service.snapshot;
    const picks: Array<vscode.QuickPickItem & { paths?: string[]; clId?: string }> = [
      { label: `$(list-unordered) ${Strings.shelf.scopeAllChanges}`, picked: true },
    ];
    for (const cl of state?.changelists ?? []) {
      picks.push({ label: `$(check-all) ${cl.name}`, description: cl.comment, clId: cl.id });
    }
    const picked = await vscode.window.showQuickPick(picks, { placeHolder: Strings.shelf.scopePrompt });
    if (!picked) {
      return undefined;
    }
    if (!picked.clId) {
      return { paths: [], defaultName: 'shelf' }; // empty paths = all changes (resolved by the caller)
    }
    const cl = state?.changelists.find((c) => c.id === picked.clId);
    if (cl && clEntry) {
      const statusPaths = clEntry.service.currentStatusPaths();
      const allowed = new Set(statusPaths.map((p) => p.toLowerCase()));
      return { paths: cl.files.filter((f) => allowed.has(f.toLowerCase())), defaultName: cl.name };
    }
    return undefined;
  }

  registerCommands(): vscode.Disposable {
    const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
      this.disposables.add(vscode.commands.registerCommand(command, handler));
    };

    const shelveFlow = async (revert: boolean, node: unknown): Promise<void> => {
      try {
        const target = await this.pickTarget(node);
        if (!target) {
          return;
        }
        const scope = await this.resolveScopePaths(target.repoKey, node);
        if (!scope) {
          return;
        }
        const name = await vscode.window.showInputBox({
          prompt: Strings.shelf.namePrompt,
          value: scope.defaultName,
          ignoreFocusOut: true,
        });
        if (name === undefined || name.trim().length === 0) {
          return;
        }
        const service = this.services.get(target.repoKey);
        if (!service) {
          return;
        }
        const paths = scope.paths.length > 0 ? scope.paths : service.currentStatusPaths();
        const entry = await service.shelve(paths, name.trim(), { revert });
        if (entry) {
          void vscode.window.showInformationMessage(
            revert
              ? `Shelved ${entry.files.length} file(s) as "${entry.name}".`
              : `Saved ${entry.files.length} file(s) to shelf "${entry.name}" (working files untouched).`,
          );
        }
      } catch (err) {
        showError('Shelve failed', err);
      }
    };

    register('jetgit.shelf.shelve', async (node: unknown) => shelveFlow(true, node));
    register('jetgit.shelf.saveToShelf', async (node: unknown) => shelveFlow(false, node));

    const applyFlow = async (node: unknown, deleteAfter: boolean): Promise<void> => {
      if (!isShelfNode(node)) {
        return;
      }
      const service = this.services.get(node.repoKey);
      if (!service) {
        return;
      }
      if (settings().value.shelf.confirmApply) {
        const shelves = await service.listLive();
        const name = shelves.find((s) => s.id === node.shelfId)?.name ?? node.shelfId;
        const confirm = await vscode.window.showWarningMessage(
          Strings.shelf.applyConfirm.replace('{name}', name),
          { modal: true },
          'Apply',
        );
        if (confirm !== 'Apply') {
          return;
        }
      }
      try {
        await service.apply(node.shelfId, { deleteAfter });
      } catch (err) {
        showError('Apply failed', err);
      }
    };

    register('jetgit.shelf.apply', async (node: unknown) => applyFlow(node, false));
    register('jetgit.shelf.applyAndDelete', async (node: unknown) => applyFlow(node, true));

    register('jetgit.shelf.rename', async (node: unknown) => {
      if (!isShelfNode(node)) {
        return;
      }
      const service = this.services.get(node.repoKey);
      const current = (await service?.listLive())?.find((s) => s.id === node.shelfId);
      const name = await vscode.window.showInputBox({
        prompt: Strings.shelf.renamePrompt,
        value: current?.name,
        ignoreFocusOut: true,
      });
      if (!name || name.trim().length === 0 || !service) {
        return;
      }
      await service.rename(node.shelfId, name.trim());
    });

    register('jetgit.shelf.delete', async (node: unknown) => {
      if (!isShelfNode(node)) {
        return;
      }
      const service = this.services.get(node.repoKey);
      if (!service) {
        return;
      }
      const shelves = await service.listLive();
      const name = shelves.find((s) => s.id === node.shelfId)?.name ?? node.shelfId;
      const confirm = await vscode.window.showWarningMessage(
        Strings.shelf.deleteConfirm.replace('{name}', name),
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') {
        return;
      }
      await service.trashById(node.shelfId);
    });

    register('jetgit.shelf.restoreDeleted', async () => {
      const target = await this.pickTarget(undefined);
      if (!target) {
        return;
      }
      const service = this.services.get(target.repoKey);
      if (!service) {
        return;
      }
      const trash = await service.listTrash();
      if (trash.length === 0) {
        void vscode.window.showInformationMessage('No deleted shelves to restore.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        trash.map((s) => ({ label: s.name, description: `${s.files.length} file(s)`, id: s.id })),
        { placeHolder: Strings.shelf.restorePrompt },
      );
      if (!picked) {
        return;
      }
      const ok = await service.restore(picked.id);
      if (!ok) {
        void vscode.window.showWarningMessage(`Could not restore "${picked.label}" — its patch file is missing.`);
      }
    });

    return this.disposables;
  }

  private async pickTarget(node: unknown): Promise<{ repoKey: string } | undefined> {
    if (
      typeof node === 'object' &&
      node !== null &&
      'repoKey' in node &&
      typeof (node as { repoKey: unknown }).repoKey === 'string'
    ) {
      return { repoKey: (node as { repoKey: string }).repoKey };
    }
    const entries = this.entries();
    const first = entries[0];
    if (entries.length === 1 && first) {
      return { repoKey: first.repo.rootUri.toString() };
    }
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(Strings.gitAvailability.noRepositories);
      return undefined;
    }
    const repos = entries.map((e) => e.repo);
    const quickPick = vscode.window.createQuickPick();
    quickPick.items = repos.map((repo) => ({ label: repo.rootUri.fsPath }));
    quickPick.placeholder = Strings.changelists.pickRepoPrompt;
    return new Promise<{ repoKey: string } | undefined>((resolve) => {
      quickPick.onDidHide(() => resolve(undefined));
      quickPick.onDidChangeSelection((selection) => {
        const picked = selection[0];
        if (picked) {
          const repo = repos.find((r) => r.rootUri.fsPath === picked.label);
          quickPick.hide();
          resolve(repo ? { repoKey: repo.rootUri.toString() } : undefined);
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

function isShelfNode(node: unknown): node is { repoKey: string; shelfId: string } {
  return typeof node === 'object' && node !== null && 'repoKey' in node && 'shelfId' in node;
}
