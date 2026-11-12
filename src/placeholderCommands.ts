/**
 * Placeholder command registry for features whose milestones have not
 * landed. Every command declared in package.json gets a real handler so
 * menus never dangle. Feature milestones REMOVE their entries here as they
 * implement them in their own module (M2–M6 commands all live in their
 * feature trees now; this file only carries jetgit.showLog).
 */
import * as vscode from 'vscode';
import { DisposableCollection } from './common/async';
import { showLog } from './common/log';
import { Strings } from './strings';

const MILESTONES: Record<string, { feature: string; milestone: string }> = {};
// No placeholders left — every package.json command is implemented (M7 may
// delete this module once the final command set is reviewed).

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
