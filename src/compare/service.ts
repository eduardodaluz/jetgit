/**
 * Compare service: holds the active comparison (one at a time), recomputes
 * it debounced on repository state changes (generation-token protected so a
 * stale recompute never overwrites a newer comparison), and exposes the
 * commit/file data the tree renders. Multi-root workspaces resolve the
 * repository at command level; the tree adds a repo layer when needed.
 */
import * as vscode from 'vscode';
import { debounce, GenerationToken } from '../common/async';
import { debug } from '../common/log';
import { settings } from '../common/settingsInstance';
import type { BlameAdapter, CommitFile } from '../blame/blameQuery';
import { commitFiles, commitInfo } from '../blame/blameQuery';
import type { GitApiService, RepoHandle } from '../git/gitApi';
import type { CommitInfo } from '../git/logParser';
import { compareCounts, compareFiles, listCommits, type CompareCounts, type CompareFile } from './compareQuery';
import { registerCompareCommands } from './commands';

export type CompareMode = 'committed' | 'worktree';

export interface CompareState {
  repoKey: string;
  ref: string;
  mode: CompareMode;
  counts: CompareCounts;
  /** Committed mode only: commits on each side of the symmetry range. */
  outgoing: CommitInfo[];
  incoming: CommitInfo[];
  files: CompareFile[];
}

function adapterFor(repo: RepoHandle): BlameAdapter {
  return {
    cwd: () => repo.rootUri.fsPath,
    runReadOnly: async (args) => repo.cli.runReadOnly(repo.rootUri.fsPath, args),
  };
}

export class CompareService {
  private state: CompareState | undefined;
  private readonly token = new GenerationToken();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires after the comparison was set, recomputed or cleared. */
  readonly onDidChange = this.changeEmitter.event;
  private repoListener: vscode.Disposable | undefined;
  private readonly reposListener: vscode.Disposable;
  private readonly scheduleRecompute: (() => void) & { cancel(): void };

  constructor(private readonly gitApi: GitApiService) {
    this.scheduleRecompute = debounce(() => void this.recompute(), 500);
    this.reposListener = gitApi.onDidChangeRepos(() => {
      const s = this.state;
      if (s && !gitApi.repositories.some((r) => r.rootUri.toString() === s.repoKey)) {
        this.clear();
      }
    });
  }

  get current(): CompareState | undefined {
    return this.state;
  }

  /** Compares HEAD against ref, committed tips only (IntelliJ default). */
  async compareWithRef(repo: RepoHandle, ref: string): Promise<void> {
    await this.compute(repo, ref, 'committed');
  }

  /** Compares the tracked working tree against ref (uncommitted work visible). */
  async compareWorkingTree(repo: RepoHandle, ref: string): Promise<void> {
    await this.compute(repo, ref, 'worktree');
  }

  clear(): void {
    this.token.invalidate();
    this.state = undefined;
    this.unwire();
    this.fire();
  }

  /** Files touched by a commit (per-commit picker), silent on failure. */
  async commitFiles(repo: RepoHandle, sha: string): Promise<CommitFile[]> {
    try {
      return await commitFiles(adapterFor(repo), sha);
    } catch (err) {
      debug(`commit files failed for ${sha} — ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Display fields of a commit (per-commit picker header), silent on failure. */
  async commitInfo(repo: RepoHandle, sha: string): Promise<{ sha: string; summary: string } | undefined> {
    try {
      return await commitInfo(adapterFor(repo), sha);
    } catch (err) {
      debug(`commit info failed for ${sha} — ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Command-level entry point: compute and surface failures to the user. */
  private async compute(repo: RepoHandle, ref: string, mode: CompareMode): Promise<void> {
    this.token.invalidate();
    const captured = this.token.capture();
    const snapshot = await this.fetchSnapshot(repo, ref, mode);
    if (!this.token.isCurrent(captured)) {
      return; // a newer comparison/recompute superseded this one
    }
    this.state = { repoKey: repo.rootUri.toString(), ref, mode, ...snapshot };
    this.rewire(repo);
    this.fire();
  }

  /** Recomputes the active comparison so counts/files never go stale. */
  private async recompute(): Promise<void> {
    const s = this.state;
    if (!s) {
      return;
    }
    const repo = this.gitApi.repositories.find((r) => r.rootUri.toString() === s.repoKey);
    if (!repo) {
      this.clear();
      return;
    }
    this.token.invalidate();
    const captured = this.token.capture();
    try {
      const snapshot = await this.fetchSnapshot(repo, s.ref, s.mode);
      if (!this.token.isCurrent(captured)) {
        return;
      }
      this.state = { ...s, ...snapshot };
      this.fire();
    } catch (err) {
      // Keep the previous snapshot (marked stale by the next successful
      // recompute) — an in-progress rebase must not blank the view.
      debug(`compare recompute failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One comparison snapshot: exact counts + capped commit lists + file matrix. */
  private async fetchSnapshot(repo: RepoHandle, ref: string, mode: CompareMode): Promise<Omit<CompareState, 'repoKey' | 'ref' | 'mode'>> {
    const adapter = adapterFor(repo);
    const maxEntries = settings().value.compare.maxCommitEntries;
    const counts = await compareCounts(adapter, ref);
    const files = await compareFiles(adapter, ref, mode);
    let outgoing: CommitInfo[] = [];
    let incoming: CommitInfo[] = [];
    if (mode === 'committed') {
      [outgoing, incoming] = await Promise.all([
        counts.outgoing > 0 ? listCommits(adapter, `${ref}..HEAD`, maxEntries) : Promise.resolve([]),
        counts.incoming > 0 ? listCommits(adapter, `HEAD..${ref}`, maxEntries) : Promise.resolve([]),
      ]);
    }
    return { counts, outgoing, incoming, files };
  }

  private rewire(repo: RepoHandle): void {
    this.unwire();
    this.repoListener = repo.onDidChangeState(() => this.scheduleRecompute());
  }

  private unwire(): void {
    this.scheduleRecompute.cancel();
    this.repoListener?.dispose();
    this.repoListener = undefined;
  }

  private fire(): void {
    this.changeEmitter.fire();
    void vscode.commands.executeCommand('setContext', 'jetgitCompareActive', this.state !== undefined);
  }

  registerCommands(): vscode.Disposable {
    return registerCompareCommands(this.gitApi, this);
  }

  dispose(): void {
    this.unwire();
    this.reposListener.dispose();
    this.changeEmitter.dispose();
  }
}
