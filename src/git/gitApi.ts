/**
 * Bridge to the built-in vscode.git extension. Sidecar rule #1: JetGit never
 * creates its own SourceControl — every repository operation goes through
 * getAPI(1) or through GitCli using the SAME binary (api.git.path).
 *
 * Graceful degradation: when vscode.git is missing/disabled, `available` is
 * false and git-dependent views show placeholders; Local History keeps
 * working (it needs no repository at all).
 */
import * as vscode from 'vscode';
import { error as logError } from '../common/log';
import { GitCli } from './gitCli';
import type { GitExtensionApi, GitExtensionExports, GitRepository } from './types';

export interface RepoHandle {
  /** Raw vscode.git repository (public API v1). */
  readonly api: GitRepository;
  readonly rootUri: vscode.Uri;
  /** Absolute git dir (resolved via rev-parse; correct for linked worktrees). */
  readonly gitDir: string;
  readonly cli: GitCli;
  readonly onDidChangeState: vscode.Event<void>;
}

const GIT_EXTENSION_ID = 'vscode.git';

export class GitApiService {
  private api: GitExtensionApi | undefined;
  private repos = new Map<string, RepoHandle>();
  private readonly disposables = new Array<vscode.Disposable>();
  private readonly availableEmitter = new vscode.EventEmitter<boolean>();
  private readonly reposEmitter = new vscode.EventEmitter<void>();

  constructor(
    private readonly stateFlag: { available: boolean },
  ) {}

  readonly onDidChangeAvailability = this.availableEmitter.event;
  readonly onDidChangeRepos = this.reposEmitter.event;

  get available(): boolean {
    return this.api !== undefined;
  }

  get repositories(): RepoHandle[] {
    return [...this.repos.values()];
  }

  /** Starts discovery; resolves when the API is usable or definitively absent. */
  async activate(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtensionExports>(GIT_EXTENSION_ID);
    if (ext) {
      await this.wireExtension(ext);
    } else {
      // The built-in git extension may be enabled later at runtime.
      this.disposables.push(
        vscode.extensions.onDidChange(() => {
          const now = vscode.extensions.getExtension<GitExtensionExports>(GIT_EXTENSION_ID);
          if (now && !this.api) {
            void this.wireExtension(now);
          }
        }),
      );
    }
  }

  private async wireExtension(ext: vscode.Extension<GitExtensionExports>): Promise<void> {
    try {
      await ext.activate();
      const api = ext.exports.getAPI(1);
      this.api = api;
      this.stateFlag.available = true;
      // React when the user disables git at runtime (git.enabled / bad git.path).
      this.disposables.push(
        api.onDidChangeState((state) => {
          if (state === 'disabled') {
            this.api = undefined;
            this.stateFlag.available = false;
            for (const key of [...this.repos.keys()]) {
              this.repos.delete(key);
            }
            this.availableEmitter.fire(false);
            this.reposEmitter.fire();
          }
        }),
      );
      // The public API v1 does NOT expose repository open/close events —
      // GitLens polls `api.repositories` for the same reason. We poll cheaply
      // and add/remove handles on diff; if a future API adds real events,
      // they take precedence below.
      const apiAny = api as unknown as {
        onOpenRepository?: vscode.Event<GitRepository>;
        onCloseRepository?: vscode.Event<GitRepository>;
      };
      if (typeof apiAny.onOpenRepository === 'function' && typeof apiAny.onCloseRepository === 'function') {
        this.disposables.push(
          apiAny.onOpenRepository((repo) => this.addRepo(repo)),
          apiAny.onCloseRepository((repo) => this.removeRepo(repo)),
        );
      } else {
        const poll = setInterval(() => this.syncRepositories(api), 2_000);
        this.disposables.push({ dispose: () => clearInterval(poll) });
      }
      this.syncRepositories(api);
      this.availableEmitter.fire(true);
      this.reposEmitter.fire();
    } catch (err) {
      // getAPI(1) throws when the user has git disabled — degrade, don't crash.
      logError('built-in Git extension API unavailable (check git.enabled, git.path, and the @builtin Git extension)', err);
    }
  }

  /** Adds missing handles / removes stale ones against the live repository list. */
  private syncRepositories(api: GitExtensionApi): void {
    const liveKeys = new Set<string>();
    for (const repo of api.repositories) {
      liveKeys.add(repo.rootUri.toString());
      this.addRepo(repo);
    }
    for (const key of [...this.repos.keys()]) {
      if (!liveKeys.has(key)) {
        this.repos.delete(key);
        this.reposEmitter.fire();
      }
    }
  }

  private addRepo(repo: GitRepository): void {
    const key = repo.rootUri.toString();
    if (this.repos.has(key) || !this.api) {
      return;
    }
    const cli = new GitCli(() => this.api!.git.path);
    // The public API v1 does not guarantee repository.onDidChangeState
    // (verified: VSCodium 1.143 lacks it — "e.onDidChangeState is not a
    // function"). We ALWAYS feed a per-repo emitter from a state-signature
    // poller; the native event, when present, is a fast-path trigger only.
    const stateEmitter = new vscode.EventEmitter<void>();
    const poll = new RepoStatePoller(repo, () => stateEmitter.fire());
    this.pollers.push(poll);
    this.disposables.push(stateEmitter, poll);
    const handle: RepoHandle = {
      api: repo,
      rootUri: repo.rootUri,
      gitDir: '', // resolved lazily via ensureGitDir
      cli,
      onDidChangeState: stateEmitter.event,
    };
    if (typeof repo.onDidChangeState === 'function') {
      this.disposables.push(repo.onDidChangeState(() => poll.checkNow()));
    }
    void this.resolveGitDir(handle);
    this.repos.set(key, handle);
    this.reposEmitter.fire();
  }

  private pollers: RepoStatePoller[] = [];

  private async resolveGitDir(handle: RepoHandle): Promise<void> {
    try {
      const stdout = await handle.cli.runReadOnlyChecked(handle.rootUri.fsPath, ['rev-parse', '--absolute-git-dir']);
      (handle as { gitDir: string }).gitDir = stdout.toString('utf8').trim();
    } catch {
      (handle as { gitDir: string }).gitDir = '';
    }
  }

  private removeRepo(repo: GitRepository): void {
    const key = repo.rootUri.toString();
    const idx = this.pollers.findIndex((p) => p.repo.rootUri.toString() === key);
    if (idx !== -1) {
      const [poller] = this.pollers.splice(idx, 1);
      poller?.dispose();
    }
    if (this.repos.delete(key)) {
      this.reposEmitter.fire();
    }
  }

  getRepoForUri(uri: vscode.Uri): RepoHandle | undefined {
    let best: RepoHandle | undefined;
    const fsPath = uri.fsPath.toLowerCase();
    for (const repo of this.repos.values()) {
      const root = repo.rootUri.fsPath.toLowerCase();
      if ((fsPath.startsWith(root + '\\') || fsPath.startsWith(root + '/')) && (!best || repo.rootUri.fsPath.length > best.rootUri.fsPath.length)) {
        best = repo;
      }
    }
    return best;
  }

  getRepoForWorkspaceRoot(root: vscode.Uri): RepoHandle | undefined {
    return this.repos.get(root.toString()) ?? this.getRepoForUri(root);
  }

  /** Resolves (and caches) the absolute git dir of a handle. */
  async ensureGitDir(handle: RepoHandle): Promise<string> {
    if (handle.gitDir === '') {
      await this.resolveGitDir(handle);
    }
    return handle.gitDir;
  }

  dispose(): void {
    for (const d of this.disposables.splice(0, this.disposables.length)) {
      d.dispose();
    }
    this.pollers = [];
    this.availableEmitter.dispose();
    this.reposEmitter.dispose();
    this.repos.clear();
  }
}

const REPO_POLL_INTERVAL_MS = 1_500;

/**
 * Detects repository state changes by diffing a cheap signature of the
 * state snapshot (HEAD, ahead/behind, change counts and paths). Fires the
 * given callback only when something actually changed, so the debounced
 * reconcile pipeline upstream is not spammed.
 */
class RepoStatePoller implements vscode.Disposable {
  private timer: NodeJS.Timeout;
  private lastSignature: string;

  constructor(
    readonly repo: GitRepository,
    private readonly fire: () => void,
  ) {
    this.lastSignature = this.signature();
    this.timer = setInterval(() => this.checkNow(), REPO_POLL_INTERVAL_MS);
  }

  checkNow(): void {
    const next = this.signature();
    if (next !== this.lastSignature) {
      this.lastSignature = next;
      this.fire();
    }
  }

  private signature(): string {
    const st = this.repo.state;
    const changes = [
      ...st.mergeChanges,
      ...st.indexChanges,
      ...st.workingTreeChanges,
      ...st.untrackedChanges,
    ].map((c) => `${c.uri.toString()}#${c.status ?? -1}`);
    // JSON of primitives — stable, cheap, collision-safe enough for diffing.
    return JSON.stringify([
      st.HEAD?.name ?? null,
      st.HEAD?.commit ?? null,
      st.HEAD?.ahead ?? null,
      st.HEAD?.behind ?? null,
      st.HEAD?.upstream?.remote ?? null,
      st.HEAD?.upstream?.name ?? null,
      changes,
    ]);
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
