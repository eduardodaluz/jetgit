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
  // M5 blame commands now live in blame/commands.ts.
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
