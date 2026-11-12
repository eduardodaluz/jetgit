/**
 * Blame commands: setMode (QuickPick → setting update — the controller
 * re-renders via the settings event), openCommit (file picker → vscode.diff
 * over `jetgit-ref:`, shared with the compare tree), copySha (hover link
 * target).
 */
import * as vscode from 'vscode';
import { showError } from '../common/log';
import { settings } from '../common/settingsInstance';
import type { GitApiService } from '../git/gitApi';
import { showCommitFileDiffPicker } from '../git/commitDiff';
import { Strings } from '../strings';
import type { BlameService } from './service';

const SHA_PATTERN = /^[0-9a-f]{6,40}$/;

export function registerBlameCommands(gitApi: GitApiService, service: BlameService): vscode.Disposable {
  const disposables = new Array<vscode.Disposable>();
  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    disposables.push(vscode.commands.registerCommand(command, handler));
  };

  register('jetgit.blame.setMode', async () => {
    const current = settings().value.blame.mode;
    const picked = await vscode.window.showQuickPick(
      [
        { label: Strings.blame.modeOff, description: Strings.blame.modeOffDesc, mode: 'off' as const, picked: current === 'off' },
        { label: Strings.blame.modeCurrentLine, description: Strings.blame.modeCurrentLineDesc, mode: 'currentLine' as const, picked: current === 'currentLine' },
        { label: Strings.blame.modeWholeFile, description: Strings.blame.modeWholeFileDesc, mode: 'wholeFile' as const, picked: current === 'wholeFile' },
      ],
      { placeHolder: Strings.blame.setModePrompt },
    );
    if (!picked || picked.mode === current) {
      return;
    }
    await vscode.workspace.getConfiguration('jetgit').update('blame.mode', picked.mode, vscode.ConfigurationTarget.Global);
  });

  register('jetgit.blame.openCommit', async (shaArg: unknown, fileUriArg: unknown) => {
    const sha = typeof shaArg === 'string' && SHA_PATTERN.test(shaArg) ? shaArg : undefined;
    if (!sha) {
      return;
    }
    const contextUri =
      typeof fileUriArg === 'string' && fileUriArg.length > 0
        ? vscode.Uri.parse(fileUriArg, true)
        : vscode.window.activeTextEditor?.document.uri;
    const repo = contextUri && contextUri.scheme === 'file' ? gitApi.getRepoForUri(contextUri) : undefined;
    if (!repo) {
      return;
    }
    try {
      const files = await service.commitFiles(repo, sha);
      const info = await service.commitInfo(repo, sha);
      await showCommitFileDiffPicker(repo.rootUri, sha, files, info?.summary, Strings.blame.commitFilesPrompt);
    } catch (err) {
      showError(Strings.blame.openCommitFailed, err);
    }
  });

  register('jetgit.blame.copySha', async (shaArg: unknown) => {
    const sha = typeof shaArg === 'string' && SHA_PATTERN.test(shaArg) ? shaArg : undefined;
    if (!sha) {
      return;
    }
    await vscode.env.clipboard.writeText(sha);
    void vscode.window.showInformationMessage(Strings.blame.copiedInfo.replace('{sha}', sha.slice(0, 8)));
  });

  return {
    dispose: () => {
      for (const d of disposables.splice(0, disposables.length)) {
        d.dispose();
      }
    },
  };
}
