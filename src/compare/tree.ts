/**
 * Compare TreeView: sections Outgoing / Incoming / Changed files under the
 * active comparison, with IntelliJ-parity file classes carried by icon
 * colors (green = only here, gray = only at the ref, blue = differs — the
 * standard gitDecoration theme tokens). An empty view falls through to the
 * viewsWelcome content; multi-repo workspaces get a repository layer.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatDateShort } from '../blame/format';
import type { RepoHandle } from '../git/gitApi';
import type { CommitInfo } from '../git/logParser';
import { Strings } from '../strings';
import type { CompareClass } from './compareQuery';
import type { CompareState } from './service';

export interface CompareRepoNode extends vscode.TreeItem {
  kind: 'repo';
  repoKey: string;
}

export interface CompareSectionNode extends vscode.TreeItem {
  kind: 'section';
  section: 'outgoing' | 'incoming' | 'files';
}

export interface CompareCommitNode extends vscode.TreeItem {
  kind: 'commit';
  repoKey: string;
  sha: string;
}

export interface CompareFileNode extends vscode.TreeItem {
  kind: 'file';
  repoKey: string;
  path: string;
  oldPath?: string;
  status: string;
  cls: CompareClass;
  ref: string;
}

export interface CompareInfoNode extends vscode.TreeItem {
  kind: 'info';
}

export type CompareTreeNode = CompareRepoNode | CompareSectionNode | CompareCommitNode | CompareFileNode | CompareInfoNode;

function colorFor(cls: CompareClass): vscode.ThemeColor {
  switch (cls) {
    case 'local':
      return new vscode.ThemeColor('gitDecoration.addedResourceColor');
    case 'ref':
      return new vscode.ThemeColor('gitDecoration.deletedResourceColor');
    default:
      return new vscode.ThemeColor('gitDecoration.modifiedResourceColor');
  }
}

export class CompareTreeProvider implements vscode.TreeDataProvider<CompareTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly stateProvider: () => CompareState | undefined,
    private readonly reposProvider: () => RepoHandle[],
    onDidChangeState: vscode.Event<void>,
  ) {
    onDidChangeState(() => this.changeEmitter.fire());
  }

  getTreeItem(element: CompareTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CompareTreeNode): Promise<CompareTreeNode[]> {
    const state = this.stateProvider();
    if (!state) {
      return []; // viewsWelcome content shows instead
    }

    if (element === undefined) {
      if (this.reposProvider().length > 1) {
        const node = new vscode.TreeItem(
          path.basename(vscode.Uri.parse(state.repoKey).fsPath),
          vscode.TreeItemCollapsibleState.Expanded,
        ) as CompareRepoNode;
        node.kind = 'repo';
        node.repoKey = state.repoKey;
        node.contextValue = 'compareRepo';
        node.iconPath = vscode.ThemeIcon.Folder;
        return [node];
      }
      return sections(state);
    }

    if (element.kind === 'repo') {
      return sections(state);
    }

    if (element.kind === 'section') {
      if (element.section === 'files') {
        return fileNodes(state);
      }
      const commits = element.section === 'outgoing' ? state.outgoing : state.incoming;
      const total = element.section === 'outgoing' ? state.counts.outgoing : state.counts.incoming;
      return commitNodes(commits, state, total);
    }

    return [];
  }
}

function sections(state: CompareState): CompareTreeNode[] {
  const nodes: CompareSectionNode[] = [];
  if (state.mode === 'committed') {
    nodes.push(makeSection(state, 'outgoing', state.counts.outgoing, 'arrow-up', Strings.compare.outgoing));
    nodes.push(makeSection(state, 'incoming', state.counts.incoming, 'arrow-down', Strings.compare.incoming));
  }
  nodes.push(makeSection(state, 'files', state.files.length, 'files', Strings.compare.changedFiles));
  return nodes;
}

function makeSection(state: CompareState, name: CompareSectionNode['section'], count: number, icon: string, label: string): CompareSectionNode {
  const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed) as CompareSectionNode;
  node.kind = 'section';
  node.section = name;
  node.description = String(count);
  if (name === 'files' && state.mode === 'worktree') {
    node.description += ` · ${Strings.compare.worktreeSuffix}`;
  }
  node.iconPath = new vscode.ThemeIcon(icon);
  node.tooltip = `${label} — vs ${state.ref}${state.mode === 'worktree' ? ` (${Strings.compare.worktreeSuffix})` : ''}`;
  return node;
}

function commitNodes(commits: readonly CommitInfo[], state: CompareState, total: number): CompareTreeNode[] {
  const nodes: CompareTreeNode[] = commits.map((c): CompareCommitNode => {
    const node = new vscode.TreeItem(c.subject, vscode.TreeItemCollapsibleState.None) as CompareCommitNode;
    node.kind = 'commit';
    node.repoKey = state.repoKey;
    node.sha = c.hash;
    node.contextValue = 'compareCommit';
    node.description = `${c.shortHash.slice(0, 8)} · ${c.authorName} · ${formatDateShort(c.authorDateSeconds)}`;
    node.iconPath = new vscode.ThemeIcon('git-commit');
    node.tooltip = `${c.subject}\n${c.authorName} <${c.authorEmail}>\n${formatDateShort(c.authorDateSeconds)} · ${c.shortHash}`;
    node.command = { command: 'jetgit.compare.openCommitFiles', title: Strings.compare.openCommitFilesTitle, arguments: [node] };
    return node;
  });
  if (commits.length < total) {
    const more = new vscode.TreeItem(
      Strings.compare.moreCommits.replace('{count}', String(total - commits.length)),
      vscode.TreeItemCollapsibleState.None,
    ) as CompareInfoNode;
    more.kind = 'info';
    more.iconPath = new vscode.ThemeIcon('ellipsis');
    nodes.push(more);
  }
  return nodes;
}

function fileNodes(state: CompareState): CompareTreeNode[] {
  return state.files.map((f): CompareFileNode => {
    const node = new vscode.TreeItem(path.posix.basename(f.path), vscode.TreeItemCollapsibleState.None) as CompareFileNode;
    node.kind = 'file';
    node.repoKey = state.repoKey;
    node.path = f.path;
    node.oldPath = f.oldPath;
    node.status = f.status;
    node.cls = f.cls;
    node.ref = state.ref;
    // "Get from Branch" only makes sense when the file exists at the ref and
    // is not a rename — those nodes expose no context menu.
    node.contextValue = f.cls === 'local' || f.status === 'R' || f.status === 'C' ? 'compareFileLocal' : 'compareFile';
    node.description = path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path);
    node.iconPath = new vscode.ThemeIcon('file', colorFor(f.cls));
    node.tooltip = classTooltip(f.cls, state.ref);
    node.command = { command: 'jetgit.compare.openFileDiff', title: Strings.compare.openFileDiffTitle, arguments: [node] };
    return node;
  });
}

function classTooltip(cls: CompareClass, ref: string): string {
  switch (cls) {
    case 'local':
      return Strings.compare.fileLocal.replace('{ref}', ref);
    case 'ref':
      return Strings.compare.fileRef.replace('{ref}', ref);
    default:
      return Strings.compare.fileDiff.replace('{ref}', ref);
  }
}
