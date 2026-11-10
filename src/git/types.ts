/**
 * Minimal mirror of the public vscode.git extension API (version 1).
 * The built-in extension exports these types at runtime; they are NOT part
 * of @types/vscode, so we declare the subset JetGit uses. Field shapes follow
 * extensions/git/src/api/git.d.ts — keep this file in sync when we adopt more.
 */
import type * as vscode from 'vscode';

export interface GitUri {
  readonly uri: vscode.Uri;
}

export interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri?: vscode.Uri;
  readonly renameUri?: vscode.Uri;
  readonly status?: number;
}

export interface GitRef {
  readonly type: number; // RefType.Head = 1, RemoteHead = 2, Tag = 3
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface GitRemote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface GitBranch {
  readonly type: number; // RefType.Head
  readonly name?: string;
  readonly commit: string;
  readonly upstream?: GitRemoteRef;
  readonly nameWithRemote?: string;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface GitRemoteRef {
  readonly remote: string;
  readonly name: string;
  readonly commit?: string;
}

export interface GitCommit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
}

export interface GitLogOptions {
  readonly maxEntries?: number;
  readonly path?: string;
  readonly range?: string;
  readonly reverse?: boolean;
  readonly author?: string;
  readonly shortStats?: boolean;
}

export interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly refs: GitRef[];
  readonly remotes: GitRemote[];
  readonly mergeChanges: GitChange[];
  readonly indexChanges: GitChange[];
  readonly workingTreeChanges: GitChange[];
  readonly untrackedChanges: GitChange[];
  readonly rebaseCommit: GitCommit | undefined;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  /** NOT part of the public API v1 in all builds — never assume it exists. */
  onDidChangeState?: vscode.Event<void>;
  blame(path: string): Promise<GitCommit & { readonly lines: string[] }>;
  log(options?: GitLogOptions): Promise<GitCommit[]>;
  show(ref: string, path: string): Promise<string>;
  getRefs(query?: { readonly pattern?: string }): Promise<GitRef[]>;
  getCommit(hash: string): Promise<GitCommit>;
  apply(patch: string, options?: { readonly reverse?: boolean; readonly index?: boolean; readonly cached?: boolean; readonly threeWay?: boolean }): Promise<void>;
  status(): Promise<void>;
}

export interface GitExtensionExports {
  getAPI(version: number): GitExtensionApi;
}

export interface GitExtensionApi {
  readonly git: {
    readonly path: string;
  };
  readonly repositories: GitRepository[];
  onDidChangeState: vscode.Event<'uninitialized' | 'initialized' | 'disabled'>;
}

export const RefType = { Head: 1, RemoteHead: 2, Tag: 3 } as const;
