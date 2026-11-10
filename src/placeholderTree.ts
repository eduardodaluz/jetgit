/**
 * Placeholder tree provider for M1: every JetGit view shows one informative
 * node. Feature milestones replace these with the real providers.
 */
import * as vscode from 'vscode';
import type { GitApiService } from './git/gitApi';

export class PlaceholderTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly message: string,
    private readonly gitApi: GitApiService,
  ) {
    gitApi.onDidChangeAvailability(() => this.changeEmitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    if (!this.gitApi.available) {
      item.iconPath = new vscode.ThemeIcon('warning');
    } else {
      item.iconPath = new vscode.ThemeIcon('info');
    }
    return [item];
  }
}
