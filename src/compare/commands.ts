/**
 * Compare commands: withRef / workingTree (repo + ref pickers → service),
 * clear, openCommitFiles (tree commit click → shared per-commit file diff
 * picker), openFileDiff (tree file click → jetgit-ref side-by-side), and
 * getFileFromRef (`git checkout <ref> -- <path>` behind a modal confirm).
 */
import * as vscode from 'vscode';
import { showError } from '../common/log';
import { showCommitFileDiffPicker } from '../git/commitDiff';
import type { GitApiService, RepoHandle } from '../git/gitApi';
import { refUri } from '../git/refContent';
import { Strings } from '../strings';
import type { CompareService } from './service';
import { groupRefs } from './compareQuery';
import type { CompareTreeNode } from './tree';

export function registerCompareCommands(gitApi: GitApiService, service: CompareService): vscode.Disposable {
  const disposables = new Array<vscode.Disposable>();
  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    disposables.push(vscode.commands.registerCommand(command, handler));
  };

  const resolveRepo = async (): Promise<RepoHandle | undefined> => {
    const active = vscode.window.activeTextEditor?.document.uri;
    const fromEditor = active && active.scheme === 'file' ? gitApi.getRepoForUri(active) : undefined;
    if (fromEditor) {
      return fromEditor;
    }
    const repos = gitApi.repositories;
    if (repos.length === 0) {
      void vscode.window.showInformationMessage(Strings.gitAvailability.noRepositories);
      return undefined;
    }
    if (repos.length === 1) {
      return repos[0];
    }
    // Multi-root: let the user pick the repository (same pattern as shelves).
    const quickPick = vscode.window.createQuickPick();
    quickPick.items = repos.map((repo) => ({ label: repo.rootUri.fsPath }));
    quickPick.placeholder = Strings.changelists.pickRepoPrompt;
    return new Promise<RepoHandle | undefined>((resolve) => {
      quickPick.onDidHide(() => resolve(undefined));
      quickPick.onDidChangeSelection((selection) => {
        const first = selection[0];
        if (first) {
          const repo = repos.find((r) => r.rootUri.fsPath === first.label);
          quickPick.hide();
          resolve(repo);
        }
      });
      quickPick.show();
    });
  };

  const pickRef = async (repo: RepoHandle): Promise<string | undefined> => {
    let groups;
    try {
      groups = groupRefs(await repo.api.getRefs({}));
    } catch (err) {
      showError(Strings.compare.compareFailed, err);
      return undefined;
    }
    if (groups.branches.length === 0 && groups.remotes.length === 0 && groups.tags.length === 0) {
      void vscode.window.showInformationMessage(Strings.compare.noRefs);
      return undefined;
    }
    const items: Array<vscode.QuickPickItem & { ref?: string }> = [];
    const pushGroup = (label: string, names: string[]): void => {
      if (names.length === 0) {
        return;
      }
      items.push({ label, kind: vscode.QuickPickItemKind.Separator });
      for (const name of names) {
        items.push({ label: name, ref: name });
      }
    };
    pushGroup(Strings.compare.branchesGroup, groups.branches);
    pushGroup(Strings.compare.remotesGroup, groups.remotes);
    pushGroup(Strings.compare.tagsGroup, groups.tags);
    const picked = await vscode.window.showQuickPick(items, { placeHolder: Strings.compare.refPrompt });
    return picked?.ref;
  };

  const startComparison = async (mode: 'committed' | 'worktree'): Promise<void> => {
    const repo = await resolveRepo();
    if (!repo) {
      return;
    }
    const ref = await pickRef(repo);
    if (!ref) {
      return;
    }
    try {
      if (mode === 'committed') {
        await service.compareWithRef(repo, ref);
      } else {
        await service.compareWorkingTree(repo, ref);
      }
    } catch (err) {
      showError(Strings.compare.compareFailed, err);
    }
  };

  const asTreeNode = (nodeArg: unknown): CompareTreeNode | undefined => {
    const node = nodeArg as CompareTreeNode | undefined;
    return node && typeof node === 'object' && 'kind' in node ? node : undefined;
  };

  const findRepoByKey = (repoKey: string): RepoHandle | undefined =>
    gitApi.repositories.find((r) => r.rootUri.toString() === repoKey);

  register('jetgit.compare.withRef', () => startComparison('committed'));

  register('jetgit.compare.workingTree', () => startComparison('worktree'));

  register('jetgit.compare.clear', () => {
    service.clear();
    void vscode.window.showInformationMessage(Strings.compare.clearedInfo);
  });

  register('jetgit.compare.openCommitFiles', async (nodeArg: unknown) => {
    const node = asTreeNode(nodeArg);
    if (!node || node.kind !== 'commit') {
      return;
    }
    const repo = findRepoByKey(node.repoKey);
    if (!repo) {
      return;
    }
    try {
      const files = await service.commitFiles(repo, node.sha);
      const info = await service.commitInfo(repo, node.sha);
      await showCommitFileDiffPicker(repo.rootUri, node.sha, files, info?.summary, Strings.compare.commitFilesPrompt);
    } catch (err) {
      showError(Strings.compare.compareFailed, err);
    }
  });

  register('jetgit.compare.openFileDiff', async (nodeArg: unknown) => {
    const node = asTreeNode(nodeArg);
    if (!node || node.kind !== 'file') {
      return;
    }
    const repo = findRepoByKey(node.repoKey);
    if (!repo) {
      return;
    }
    const root = repo.rootUri;
    const left = refUri(root, node.ref, node.oldPath ?? node.path);
    // Only-at-ref files are absent from HEAD and the working tree — the
    // right side degrades to the provider's explanatory placeholder.
    const right = node.cls === 'ref' ? refUri(root, 'HEAD', node.path) : vscode.Uri.joinPath(root, node.path);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${node.path} (${node.ref})`);
  });

  register('jetgit.compare.getFileFromRef', async (nodeArg: unknown) => {
    const node = asTreeNode(nodeArg);
    if (!node || node.kind !== 'file') {
      return;
    }
    if (node.status === 'R' || node.status === 'C') {
      void vscode.window.showInformationMessage(Strings.compare.renameUnsupported);
      return;
    }
    const repo = findRepoByKey(node.repoKey);
    if (!repo) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      Strings.compare.getFileConfirm.replace('{file}', node.path).replace('{ref}', node.ref),
      { modal: true },
      Strings.compare.overwriteButton,
    );
    if (confirm !== Strings.compare.overwriteButton) {
      return;
    }
    try {
      await repo.cli.runChecked(repo.rootUri.fsPath, ['checkout', node.ref, '--', node.path]);
      void vscode.window.showInformationMessage(
        Strings.compare.restoredInfo.replace('{file}', node.path).replace('{ref}', node.ref),
      );
    } catch (err) {
      showError(Strings.compare.getFailed, err);
    }
  });

  return {
    dispose: () => {
      for (const d of disposables.splice(0, disposables.length)) {
        d.dispose();
      }
    },
  };
}
