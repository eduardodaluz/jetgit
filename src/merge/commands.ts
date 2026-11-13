/**
 * MergeController (M6.8): owns one MergeService per repository and registers
 * every `jetgit.merge.*` command. Mirrors the ChangelistsController pattern:
 * services keyed by repo root, tree nodes carry repoKey (+ relPath) so
 * commands work from any window with any repo focused.
 *
 * One-click conflict resolution: Accept Yours / Accept Theirs work on a
 * single file node or a multi-select (VS Code passes the focused node plus
 * the selected array, like changelists.moveFiles). Resolution is staging;
 * finishing the operation is the separate Complete Merge / continue-rebase
 * flow.
 */
import * as vscode from 'vscode';
import { DisposableCollection } from '../common/async';
import { showError } from '../common/log';
import type { GitApiService, RepoHandle } from '../git/gitApi';
import { Strings } from '../strings';
import { MergeService } from './service';
import type { MergeOperation } from './probe';
import type { MergeConflictFileNode, MergeNode } from '../changelists/tree';

export class MergeController {
  private readonly services = new Map<string, MergeService>();
  private readonly disposables = new DisposableCollection();
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  /** Fires whenever any per-repo service's merge snapshot changes. */
  readonly onDidChangeServices = this.changeEmitter.event;

  constructor(private readonly gitApi: GitApiService) {
    this.disposables.add(gitApi.onDidChangeRepos(() => void this.syncRepos()));
    void this.syncRepos();
  }

  /** Snapshot of live repo+service pairs (drives the tree provider). */
  entries(): Array<{ repo: RepoHandle; merge: MergeService }> {
    const out: Array<{ repo: RepoHandle; merge: MergeService }> = [];
    for (const [key, merge] of this.services) {
      const repo = this.gitApi.repositories.find((r) => r.rootUri.toString() === key);
      if (repo) {
        out.push({ repo, merge });
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
          const service = new MergeService(repo, gitDir || '');
          await service.ready();
          this.services.set(key, service);
          this.disposables.add(
            service.onDidChange(() => {
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

  private serviceFor(repoKey: string): MergeService | undefined {
    return this.services.get(repoKey);
  }

  /** Accepts one side for every given conflict file of a single repository. */
  private async accept(repoKey: string, relPaths: readonly string[], side: 'ours' | 'theirs'): Promise<void> {
    const service = this.serviceFor(repoKey);
    if (!service) {
      return;
    }
    try {
      await service.resolve(relPaths, side);
    } catch (err) {
      await showError(Strings.merge.resolveFailed, err);
    }
  }

  registerCommands(): vscode.Disposable {
    const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
      this.disposables.add(vscode.commands.registerCommand(command, handler));
    };

    // Single node OR multi-select array (VS Code passes the focused node
    // first, then the whole selection — the changelists.moveFiles contract).
    const conflictFilesOf = (node: unknown, nodes: unknown): MergeConflictFileNode[] => {
      const all = [node, ...(Array.isArray(nodes) ? nodes : [])];
      const files = all.filter(isMergeConflictFileNode);
      const first = files[0];
      return first ? files.filter((f) => f.repoKey === first.repoKey) : [];
    };

    register('jetgit.merge.acceptYours', async (node: unknown, nodes: unknown) => {
      const files = conflictFilesOf(node, nodes);
      const first = files[0];
      if (first) {
        await this.accept(first.repoKey, files.map((f) => f.relPath), 'ours');
      }
    });

    register('jetgit.merge.acceptTheirs', async (node: unknown, nodes: unknown) => {
      const files = conflictFilesOf(node, nodes);
      const first = files[0];
      if (first) {
        await this.accept(first.repoKey, files.map((f) => f.relPath), 'theirs');
      }
    });

    register('jetgit.merge.openMergeEditor', async (node: unknown) => {
      if (!isMergeConflictFileNode(node)) {
        return;
      }
      const repo = this.gitApi.repositories.find((r) => r.rootUri.toString() === node.repoKey);
      if (!repo) {
        return;
      }
      const fileUri = vscode.Uri.joinPath(repo.rootUri, node.relPath);
      try {
        // The native 3-way merge editor lives in the built-in git extension —
        // `git.openMergeEditor` is its PUBLIC entry point (stages :1/:2/:3,
        // rename-aware). When built-in git is disabled the command rejects.
        await vscode.commands.executeCommand('git.openMergeEditor', fileUri);
      } catch (err) {
        await showError(Strings.merge.resolveFailed, err);
      }
    });

    register('jetgit.merge.openFile', async (node: unknown) => {
      if (!isMergeConflictFileNode(node)) {
        return;
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(`${node.rootFsPath}/${node.relPath}`));
    });

    register('jetgit.merge.complete', async (node: unknown) => {
      if (!isMergeNode(node)) {
        return;
      }
      const service = this.serviceFor(node.repoKey);
      if (!service) {
        return;
      }
      const snapshot = service.snapshot;
      if (snapshot && snapshot.conflicts.length > 0) {
        void vscode.window.showWarningMessage(
          Strings.merge.completeBlockedRemaining.replace('{count}', String(snapshot.conflicts.length)),
        );
        return;
      }
      // Rebases conclude with `rebase --continue` (its message flow is git's
      // own); every other operation is one plain commit, message pre-filled
      // from MERGE_MSG with the cursor at the end (changelist-commit parity).
      if (node.operation === 'rebase') {
        try {
          await service.continueRebase();
        } catch (err) {
          await showError(Strings.merge.resolveFailed, err);
        }
        return;
      }
      const prefill = service.readMergeMessage();
      const message = await vscode.window.showInputBox({
        prompt: Strings.merge.completePrompt,
        value: prefill,
        valueSelection: prefill.length > 0 ? [prefill.length, prefill.length] : undefined,
        ignoreFocusOut: true,
      });
      if (message === undefined || message.trim().length === 0) {
        return;
      }
      try {
        await service.completeMerge(message);
        void vscode.window.showInformationMessage(Strings.merge.completedInfo);
      } catch (err) {
        await showError(Strings.merge.resolveFailed, err);
      }
    });

    register('jetgit.merge.abort', async (node: unknown) => {
      if (!isMergeNode(node)) {
        return;
      }
      const service = this.serviceFor(node.repoKey);
      if (!service) {
        return;
      }
      const title = abortTitle(node.operation);
      if (!title) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(Strings.merge.abortConfirm, { modal: true }, title);
      if (confirm !== title) {
        return;
      }
      try {
        await service.abort();
        void vscode.window.showInformationMessage(Strings.merge.abortedInfo);
      } catch (err) {
        await showError(Strings.merge.resolveFailed, err);
      }
    });

    return this.disposables;
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

function abortTitle(operation: MergeOperation): string | undefined {
  switch (operation) {
    case 'merge':
      return Strings.merge.abortMerge;
    case 'cherry-pick':
      return Strings.merge.abortCherryPick;
    case 'revert':
      return Strings.merge.abortRevert;
    case 'rebase':
      return Strings.merge.abortRebase;
    case 'unknown':
      return undefined;
  }
}

export function isMergeNode(node: unknown): node is MergeNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { kind?: unknown }).kind === 'merge' &&
    typeof (node as { repoKey?: unknown }).repoKey === 'string'
  );
}

export function isMergeConflictFileNode(node: unknown): node is MergeConflictFileNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { kind?: unknown }).kind === 'mergeConflictFile' &&
    typeof (node as { repoKey?: unknown }).repoKey === 'string' &&
    typeof (node as { relPath?: unknown }).relPath === 'string'
  );
}
