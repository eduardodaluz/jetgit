/**
 * JetGit activation. This module only wires services and disposables —
 * feature logic lives in its own module tree.
 *
 * Milestones: M1 scaffold (log/settings/git bridge/placeholder views),
 * M2 changelists, M3 shelves, M4 local history, M5 inline blame, M6 compare,
 * M6.5 commit review + partial rollback, M6.7 hunk-level commit inclusion,
 * M6.8 merge conflict experience. M7 (polish + publish) remains.
 */
import * as vscode from 'vscode';
import { DisposableCollection } from './common/async';
import { initLog, setLogLevel } from './common/log';
import { settings } from './common/settingsInstance';
import { GitApiService } from './git/gitApi';
import { registerPlaceholderCommands } from './placeholderCommands';
import { ChangelistsController } from './changelists/commands';
import { ChangelistsDragAndDrop, ChangelistsTreeProvider } from './changelists/tree';
import { MergeController } from './merge/commands';
import { ShelfController } from './shelf/commands';
import { ShelfTreeProvider } from './shelf/tree';
import { LocalHistoryController } from './localHistory/commands';
import { BlameController } from './blame/controller';
import { registerRefContentProvider } from './git/refContent';
import { CompareService } from './compare/service';
import { CompareTreeProvider } from './compare/tree';
import { ChangesReviewController } from './changes/review';
import { registerChangesCommands } from './changes/commands';

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
  // --- M6.7: commit review controller (hunk sessions + partial commits) ---
  const review = new ChangesReviewController(gitApi);
  changelists.attachReview(review);
  review.attachTreeChecked((repoKey, relPath) => changelists.isTreeChecked(repoKey, relPath));
  // --- M6.8: merge conflict experience (banner node + Accept Yours/Theirs) ---
  const merge = new MergeController(gitApi);
  disposables.add(merge);
  const changelistsTree = new ChangelistsTreeProvider(
    () => changelists.entries(),
    changelists.onDidChangeServices,
    (repoKey, changelistId, relPath) => changelists.isJoining(repoKey, changelistId, relPath),
    (repoKey, changelistId, relPath) => changelists.partialLabel(repoKey, changelistId, relPath),
    () => merge.entries(),
  );
  const changelistsTreeView = vscode.window.createTreeView('jetgitChangelists', {
    treeDataProvider: changelistsTree,
    dragAndDropController: new ChangelistsDragAndDrop(),
  });
  disposables.add(changelistsTreeView);
  disposables.add(changelistsTreeView.onDidChangeCheckboxState((items) => changelists.handleCheckboxChange(items)));
  disposables.add(changelists.registerCommands());
  disposables.add(review.register());
  disposables.add(review.onDidChangeReview(() => changelistsTree.refresh()));
  disposables.add(merge.registerCommands());
  disposables.add(merge.onDidChangeServices(() => changelistsTree.refresh()));

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

  // --- M6: Compare with ref (real implementation) ---
  const compare = new CompareService(gitApi);
  disposables.add(compare);
  const compareTree = new CompareTreeProvider(
    () => compare.current,
    () => gitApi.repositories,
    compare.onDidChange,
  );
  disposables.add(vscode.window.createTreeView('jetgitCompare', { treeDataProvider: compareTree }));
  disposables.add(compare.registerCommands());

  // --- M6.5: Commit review + partial rollback ---
  disposables.add(registerChangesCommands(gitApi, review));
  disposables.add(registerPlaceholderCommands());
}

export function deactivate(): void {
  // All cleanup runs through context.subscriptions disposables.
}
