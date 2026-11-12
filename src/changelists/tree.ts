/**
 * Changelists TreeView with drag-and-drop between changelists.
 * Layout: single repo → changelists at the top level; multi-root → one
 * repository node per repo, changelists beneath. The active changelist sorts
 * first and carries a distinct icon (IntelliJ-style emphasis).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../git/gitApi';
import { Strings } from '../strings';
import type { Changelist, ChangelistsState } from './model';
import type { ChangelistsService } from './service';

export interface ChangelistNode extends vscode.TreeItem {
  kind: 'changelist';
  repoKey: string;
  changelistId: string;
}

export interface ChangelistFileNode extends vscode.TreeItem {
  kind: 'changelistFile';
  repoKey: string;
  changelistId: string;
  /** Repo-relative path, original case. */
  relPath: string;
  rootFsPath: string;
}

export interface RepoNode extends vscode.TreeItem {
  kind: 'repo';
  repoKey: string;
}

export interface InfoNode extends vscode.TreeItem {
  kind: 'info';
}

export type JetGitChangelistsTreeNode = ChangelistNode | ChangelistFileNode | RepoNode | InfoNode;

export const MIME_JETGIT_CHANGELISTS = 'application/vnd.code.tree.jetgitchangelists';

export class ChangelistsTreeProvider implements vscode.TreeDataProvider<JetGitChangelistsTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly reposProvider: () => Array<{ repo: RepoHandle; service: ChangelistsService }>,
    onDidChangeServices: vscode.Event<void>,
  ) {
    onDidChangeServices(() => this.changeEmitter.fire());
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: JetGitChangelistsTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: JetGitChangelistsTreeNode): Promise<JetGitChangelistsTreeNode[]> {
    const entries = this.reposProvider();
    if (entries.length === 0) {
      const item = new vscode.TreeItem(Strings.gitAvailability.requiresGit, vscode.TreeItemCollapsibleState.None) as InfoNode;
      item.kind = 'info';
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item];
    }

    // Top level: repos (only rendered as a layer when there are several).
    if (element === undefined) {
      const first = entries[0];
      if (entries.length === 1 && first) {
        return this.getChangelistNodes(first.repo, first.service);
      }
      return entries.map(({ repo }): RepoNode => {
        const node = new vscode.TreeItem(path.basename(repo.rootUri.fsPath), vscode.TreeItemCollapsibleState.Expanded) as RepoNode;
        node.kind = 'repo';
        node.repoKey = repo.rootUri.toString();
        node.contextValue = 'repo';
        node.iconPath = vscode.ThemeIcon.Folder;
        return node;
      });
    }

    if (element.kind === 'repo') {
      const entry = entries.find((e) => e.repo.rootUri.toString() === element.repoKey);
      if (!entry) {
        return [];
      }
      return this.getChangelistNodes(entry.repo, entry.service);
    }

    if (element.kind === 'changelist') {
      const entry = entries.find((e) => e.repo.rootUri.toString() === element.repoKey);
      const state = entry?.service.snapshot;
      if (!entry || !state) {
        return [];
      }
      const cl = state.changelists.find((c) => c.id === element.changelistId);
      if (!cl) {
        return [];
      }
      return cl.files.map((relPath) => this.fileNode(element.repoKey, entry.repo.rootUri.fsPath, cl.id, relPath));
    }

    return [];
  }

  private getChangelistNodes(repo: RepoHandle, service: ChangelistsService): ChangelistNode[] {
    const state: ChangelistsState | undefined = service.snapshot;
    if (!state) {
      return [];
    }
    const sorted = [...state.changelists].sort((a, b) => {
      const activeA = a.id === state.activeId ? 0 : 1;
      const activeB = b.id === state.activeId ? 0 : 1;
      return activeA - activeB || a.name.localeCompare(b.name);
    });
    return sorted.map((cl: Changelist): ChangelistNode => {
      const isActive = cl.id === state.activeId;
      const node = new vscode.TreeItem(
        cl.name,
        cl.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      ) as ChangelistNode;
      node.kind = 'changelist';
      node.repoKey = repo.rootUri.toString();
      node.changelistId = cl.id;
      node.contextValue = 'changelist';
      node.description = cl.comment ?? `${cl.files.length} file(s)`;
      node.iconPath = new vscode.ThemeIcon(isActive ? 'check-all' : 'list-unordered');
      node.tooltip = new vscode.MarkdownString(
        `${isActive ? '**Active changelist**\n\n' : ''}**${cl.name}** (${cl.files.length} file(s))${cl.comment ? `\n\n${cl.comment}` : ''}`,
      );
      return node;
    });
  }

  private fileNode(repoKey: string, rootFsPath: string, changelistId: string, relPath: string): ChangelistFileNode {
    const node = new vscode.TreeItem(path.posix.basename(relPath), vscode.TreeItemCollapsibleState.None) as ChangelistFileNode;
    node.kind = 'changelistFile';
    node.repoKey = repoKey;
    node.changelistId = changelistId;
    node.relPath = relPath;
    node.rootFsPath = rootFsPath;
    node.contextValue = 'changelistFile';
    node.description = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
    node.iconPath = vscode.ThemeIcon.File;
    // Opening a change shows the HEAD↔worktree diff (editable right pane) —
    // the plain file stays reachable via the "Open File" context action.
    node.command = { command: 'jetgit.changes.openDiff', title: 'Show Diff', arguments: [node] };
    return node;
  }
}

/**
 * Drag-and-drop: file nodes dragged onto a changelist node move files.
 * Payload travels as a JSON string inside the DataTransferItem (the API has
 * no structured values).
 */
export class ChangelistsDragAndDrop implements vscode.TreeDragAndDropController<JetGitChangelistsTreeNode> {
  readonly dropMimeTypes = [MIME_JETGIT_CHANGELISTS];
  readonly dragMimeTypes = [MIME_JETGIT_CHANGELISTS];

  handleDrag(source: readonly JetGitChangelistsTreeNode[], dataTransfer: vscode.DataTransfer): void {
    const files = source.filter((n): n is ChangelistFileNode => n.kind === 'changelistFile');
    if (files.length === 0) {
      return;
    }
    const payload = files.map((f) => ({ repoKey: f.repoKey, changelistId: f.changelistId, relPath: f.relPath }));
    // vscode.DataTransferItem.value round-trips the original object within the
    // same extension host (guaranteed for in-tree drag-and-drop).
    dataTransfer.set(MIME_JETGIT_CHANGELISTS, new vscode.DataTransferItem(payload));
  }

  async handleDrop(
    target: JetGitChangelistsTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    if (!target || target.kind !== 'changelist') {
      return;
    }
    const item = dataTransfer.get(MIME_JETGIT_CHANGELISTS);
    if (!item) {
      return;
    }
    let payload: Array<{ repoKey: string; changelistId: string; relPath: string }>;
    try {
      payload = typeof item.value === 'string' ? JSON.parse(item.value) : item.value;
    } catch {
      return;
    }
    if (!Array.isArray(payload) || payload.length === 0) {
      return;
    }
    const sameRepo = payload.every((p) => p.repoKey === target.repoKey);
    if (!sameRepo) {
      return; // moving files between repos is not supported
    }
    if (payload.every((p) => p.changelistId === target.changelistId)) {
      return; // no-op drop
    }
    await vscode.commands.executeCommand(
      'jetgit.changelists.moveFilesInternal',
      payload.map((p) => p.relPath),
      target.repoKey,
      target.changelistId,
    );
  }
}
