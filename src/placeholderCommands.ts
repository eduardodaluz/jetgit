/**
 * Placeholder command registry for features whose milestones have not landed.
 * Every command declared in package.json gets a real handler so menus never
 * dangle. Feature milestones REMOVE their entries here as they implement
 * them in their own module (M2 changelists already live in changelists/).
 */
import * as vscode from 'vscode';
import { DisposableCollection } from './common/async';
import { showLog } from './common/log';
import { Strings } from './strings';

const MILESTONES: Record<string, { feature: string; milestone: string }> = {
  'jetgit.localHistory.putLabel': { feature: 'Local History labels', milestone: 'milestone 4' },
  'jetgit.localHistory.restore': { feature: 'Restore from Local History', milestone: 'milestone 4' },
  'jetgit.localHistory.restoreDeleted': { feature: 'Restore deleted files', milestone: 'milestone 4' },
  'jetgit.localHistory.showDiff': { feature: 'Local History diffs', milestone: 'milestone 4' },
  'jetgit.localHistory.clear': { feature: 'Clear Local History', milestone: 'milestone 4' },
  'jetgit.localHistory.storageUsage': { feature: 'Storage usage report', milestone: 'milestone 4' },
  'jetgit.blame.setMode': { feature: 'Blame modes', milestone: 'milestone 5' },
  'jetgit.blame.openCommit': { feature: 'Open Commit', milestone: 'milestone 5' },
  'jetgit.blame.copySha': { feature: 'Copy Commit SHA', milestone: 'milestone 5' },
  'jetgit.compare.withRef': { feature: 'Compare with Ref', milestone: 'milestone 6' },
  'jetgit.compare.workingTree': { feature: 'Compare Working Tree', milestone: 'milestone 6' },
  'jetgit.compare.getFileFromRef': { feature: 'Get from Branch', milestone: 'milestone 6' },
  'jetgit.compare.openCommitFiles': { feature: 'Commit file diffs', milestone: 'milestone 6' },
  'jetgit.compare.clear': { feature: 'Clear Comparison', milestone: 'milestone 6' },
};

export function registerPlaceholderCommands(): vscode.Disposable {
  const disposables = new DisposableCollection();
  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    disposables.add(vscode.commands.registerCommand(command, handler));
  };

  for (const [command, meta] of Object.entries(MILESTONES)) {
    register(command, () => {
      void vscode.window.showInformationMessage(
        Strings.placeholders.commandNotYet.replace('{feature}', meta.feature).replace('{milestone}', meta.milestone),
      );
    });
  }

  register('jetgit.showLog', () => showLog());

  return disposables;
}
