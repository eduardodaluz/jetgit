/**
 * JetGit activation. This module only wires services and disposables —
 * feature logic lives in its own module tree.
 *
 * Milestones: M1 scaffold (log/settings/git bridge/placeholder views),
 * M2 changelists, M3 shelves, M4 local history, M5 inline blame.
 * Compare lands in M6 and keeps its placeholder until then.
 */
import * as vscode from 'vscode';
import { DisposableCollection } from './common/async';
import { initLog, setLogLevel } from './common/log';
import { settings } from './common/settingsInstance';
import { Strings } from './strings';
import { GitApiService } from './git/gitApi';
import { PlaceholderTreeProvider } from './placeholderTree';
import { registerPlaceholderCommands } from './placeholderCommands';
import { ChangelistsController } from './changelists/commands';
import { ChangelistsDragAndDrop, ChangelistsTreeProvider } from './changelists/tree';
import { ShelfController } from './shelf/commands';
import { ShelfTreeProvider } from './shelf/tree';
import { LocalHistoryController } from './localHistory/commands';
import { BlameController } from './blame/controller';
import { registerRefContentProvider } from './git/refContent';

export function activate(context: vscode.ExtensionContext): void {
  const disposables = new DisposableCollection();
  context.subscriptions.push(disposables);

  const outputChannel = vscode.window.createOutputChannel('JetGit');
  disposables.add(outputChannel);
  const settingsService = settings();
  disposables.add(settingsService);
  initLog(outputChannel, settingsService.value.log.level);
  disposables.add(settingsService.onDidChange((s) => setLogLevel(s.log.level)));

  const availabilityFlag = { available: false };
  const gitApi = new GitApiService(availabilityFlag);
  disposables.add(gitApi);
  void gitApi.activate();

  // --- M2: Changelists (real implementation) ---
  const changelists = new ChangelistsController(gitApi);
  disposables.add(changelists);
  const changelistsTree = new ChangelistsTreeProvider(() => changelists.entries(), changelists.onDidChangeServices);
  const changelistsTreeView = vscode.window.createTreeView('jetgitChangelists', {
    treeDataProvider: changelistsTree,
    dragAndDropController: new ChangelistsDragAndDrop(),
  });
  disposables.add(changelistsTreeView);
  disposables.add(changelists.registerCommands());

  // --- M3: Shelves (real implementation) ---
  const shelves = new ShelfController(gitApi, { changelistEntries: () => changelists.entries() });
  disposables.add(shelves);
  const shelvesTree = new ShelfTreeProvider(() => shelves.entries(), shelves.onDidChangeServices);
  disposables.add(vscode.window.createTreeView('jetgitShelves', { treeDataProvider: shelvesTree }));
  disposables.add(shelves.registerCommands());

  // --- M4: Local History (real implementation; works without git) ---
  const localHistory = new LocalHistoryController(context);
  disposables.add(localHistory);

  // --- M5: Inline blame (real implementation; sidecar over vscode.git) ---
  const blame = new BlameController(gitApi, context);
  disposables.add(blame);
  disposables.add(blame.registerCommands());
  disposables.add(registerRefContentProvider(gitApi));

  // --- M6 placeholder ---
  disposables.add(
    vscode.window.createTreeView('jetgitCompare', {
      treeDataProvider: new PlaceholderTreeProvider(Strings.placeholders.compareMilestone, gitApi),
    }),
  );
  disposables.add(registerPlaceholderCommands());
}

export function deactivate(): void {
  // All cleanup runs through context.subscriptions disposables.
}
