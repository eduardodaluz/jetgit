/**
 * Shelves TreeView: one node per shelf (expandable to its file list from the
 * parsed patch), newest first; multi-repo workspaces get a repository layer.
 * Shelves whose patch file is missing render as "[missing patch]".
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../git/gitApi';
import { Strings } from '../strings';
import type { ShelfEntry } from './model';
import type { ShelfService } from './service';

export interface ShelfNode extends vscode.TreeItem {
  kind: 'shelf';
  repoKey: string;
  shelfId: string;
}

export interface ShelfFileNode extends vscode.TreeItem {
  kind: 'shelfFile';
  repoKey: string;
}

export interface ShelfRepoNode extends vscode.TreeItem {
  kind: 'shelfRepo';
  repoKey: string;
}

export interface ShelfInfoNode extends vscode.TreeItem {
  kind: 'shelfInfo';
}

export type JetGitShelfTreeNode = ShelfNode | ShelfFileNode | ShelfRepoNode | ShelfInfoNode;

interface RepoEntry {
  repo: RepoHandle;
  service: ShelfService;
}

export class ShelfTreeProvider implements vscode.TreeDataProvider<JetGitShelfTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly reposProvider: () => RepoEntry[],
    onDidChangeServices: vscode.Event<void>,
  ) {
    onDidChangeServices(() => this.changeEmitter.fire());
  }

  getTreeItem(element: JetGitShelfTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: JetGitShelfTreeNode): Promise<JetGitShelfTreeNode[]> {
    const entries = this.reposProvider();
    if (entries.length === 0) {
      const item = new vscode.TreeItem(Strings.gitAvailability.requiresGit, vscode.TreeItemCollapsibleState.None) as ShelfInfoNode;
      item.kind = 'shelfInfo';
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item];
    }

    if (element === undefined) {
      const first = entries[0];
      if (entries.length === 1 && first) {
        return this.getShelfNodes(first);
      }
      return entries.map(({ repo }): ShelfRepoNode => {
        const node = new vscode.TreeItem(path.basename(repo.rootUri.fsPath), vscode.TreeItemCollapsibleState.Expanded) as ShelfRepoNode;
        node.kind = 'shelfRepo';
        node.repoKey = repo.rootUri.toString();
        node.contextValue = 'shelfRepo';
        node.iconPath = vscode.ThemeIcon.Folder;
        return node;
      });
    }

    if (element.kind === 'shelfRepo') {
      const entry = entries.find((e) => e.repo.rootUri.toString() === element.repoKey);
      return entry ? this.getShelfNodes(entry) : [];
    }

    if (element.kind === 'shelf') {
      const entry = entries.find((e) => e.repo.rootUri.toString() === element.repoKey);
      const shelf = entry ? (await entry.service.listLive()).find((s) => s.id === element.shelfId) : undefined;
      if (!entry || !shelf) {
        return [];
      }
      return shelf.files.map((relPath): ShelfFileNode => {
        const node = new vscode.TreeItem(path.posix.basename(relPath), vscode.TreeItemCollapsibleState.None) as ShelfFileNode;
        node.kind = 'shelfFile';
        node.repoKey = element.repoKey;
        node.description = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
        node.iconPath = vscode.ThemeIcon.File;
        return node;
      });
    }

    return [];
  }

  private async getShelfNodes({ repo, service }: RepoEntry): Promise<JetGitShelfTreeNode[]> {
    const shelves = await service.listLive();
    const nodes = await Promise.all(
      shelves.map(async (shelf: ShelfEntry): Promise<ShelfNode> => {
        const node = new vscode.TreeItem(
          shelf.name,
          shelf.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        ) as ShelfNode;
        node.kind = 'shelf';
        node.repoKey = repo.rootUri.toString();
        node.shelfId = shelf.id;
        node.contextValue = 'shelf';
        const missing = await service.missingPatch(shelf).catch(() => false);
        node.description = missing
          ? '[missing patch]'
          : `${shelf.files.length} file(s) · ${formatAge(shelf.createdAt)}${shelf.reverted ? '' : ' · saved'}`;
        node.iconPath = new vscode.ThemeIcon(missing ? 'error' : 'archive');
        node.tooltip = new vscode.MarkdownString(
          `**${shelf.name}**\n\n${shelf.files.length} file(s) · ${formatBytes(shelf.bytes)} · created ${new Date(shelf.createdAt).toLocaleString()}${shelf.untrackedCount > 0 ? `\n\n${shelf.untrackedCount} untracked file(s) included` : ''}`,
        );
        return node;
      }),
    );
    return nodes;
  }
}

function formatAge(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
