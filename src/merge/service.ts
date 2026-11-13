/**
 * Per-repository merge service (M6.8): knows whether a merge / cherry-pick /
 * revert / rebase is in progress, which paths are unmerged, and how to
 * resolve, complete or abort the operation.
 *
 * Event-driven probe: the service subscribes to repo.onDidChangeState (the
 * RepoStatePoller signature already includes state.mergeChanges, so conflict
 * set changes fire for free), debounces 300 ms, then snapshots from two
 * sources — (a) fs.existsSync on MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD
 * plus the rebase-merge / rebase-apply dirs under the ABSOLUTE git dir
 * (worktree-safe; same guard the M2 commit flow uses), and (b) ONE
 * `git status --porcelain=v1 -z` via runReadOnlyChecked (--no-optional-locks
 * injected by GitCli; never contends with the built-in extension). The CLI is
 * the source of truth: the vscode.git v1 Status enum does not expose the
 * operation type nor the per-path unmerged code.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { debounce } from '../common/async';
import { pathspecArgs, TempTextFile, withPathspecFiles } from '../git/gitCli';
import type { RepoHandle } from '../git/gitApi';
import {
  buildSnapshot,
  detectOperation,
  resolvePlan,
  type MergeOperation,
  type MergeSnapshot,
  type OperationFlags,
  type ResolveSide,
  type UnmergedCode,
} from './probe';

/** Debounce applied to state-driven refreshes (mirrors the changelists service). */
const REFRESH_DEBOUNCE_MS = 300;

export class MergeService {
  private snapshotValue: MergeSnapshot | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly stateListener: vscode.Disposable;
  private readonly refreshDebounced: ((...args: []) => void) & { cancel(): void };
  /** True while resolve/complete/abort runs git — suppresses state-driven refreshes. */
  private mutating = false;

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly repo: RepoHandle,
    private readonly gitDir: string,
  ) {
    this.refreshDebounced = debounce(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
    this.stateListener = repo.onDidChangeState(() => {
      if (!this.mutating) {
        this.refreshDebounced();
      }
    });
  }

  /** Current snapshot; undefined means no merge operation in progress. */
  get snapshot(): MergeSnapshot | undefined {
    return this.snapshotValue;
  }

  async ready(): Promise<void> {
    await this.refresh();
  }

  /**
   * Re-probes the repository. No operation marker → snapshot undefined (a
   * clean tree shows no merge nodes). A transient status failure keeps the
   * previous snapshot so the tree never flaps mid-reindex.
   */
  async refresh(): Promise<void> {
    const flags = this.detectFlags();
    if (detectOperation(flags) === 'unknown') {
      this.setSnapshot(undefined);
      return;
    }
    try {
      const stdout = await this.repo.cli.runReadOnlyChecked(this.repo.rootUri.fsPath, ['status', '--porcelain=v1', '-z']);
      this.setSnapshot(buildSnapshot(flags, stdout.toString('utf8')));
    } catch {
      // Transient (locked index, replaced ref): keep the last known snapshot.
    }
  }

  private detectFlags(): OperationFlags {
    if (this.gitDir === '') {
      return {};
    }
    const dir = this.gitDir;
    const has = (...names: string[]): boolean => names.some((n) => fs.existsSync(path.join(dir, ...n.split('/'))));
    return {
      mergeHead: has('MERGE_HEAD'),
      cherryPickHead: has('CHERRY_PICK_HEAD'),
      revertHead: has('REVERT_HEAD'),
      rebaseMerge: fs.existsSync(path.join(dir, 'rebase-merge')),
      rebaseApply: fs.existsSync(path.join(dir, 'rebase-apply')),
    };
  }

  private setSnapshot(next: MergeSnapshot | undefined): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.snapshotValue);
    this.snapshotValue = next;
    if (changed) {
      this.changeEmitter.fire();
    }
  }

  /**
   * Resolves the given unmerged paths by "accepting" one side — resolution
   * IS staging (IntelliJ parity). Paths are grouped by their resolvePlan
   * BEFORE any git call so each operation runs as few times as possible:
   * checkout group (`checkout --ours|--theirs`) first, then staging
   * (`add -f` — covers both checked-out paths and pure-stage cases), then
   * removals (`rm --force`). Paths no longer in the snapshot are skipped
   * (the state moved between render and click). Throws GitCliError on
   * failure — nothing was silently swallowed.
   */
  async resolve(relPaths: readonly string[], side: ResolveSide): Promise<void> {
    const snapshot = this.snapshotValue;
    if (!snapshot || relPaths.length === 0) {
      return;
    }
    const codeOf = new Map<string, UnmergedCode>(snapshot.conflicts.map((c) => [c.path, c.code]));
    const checkout: string[] = [];
    const stage: string[] = [];
    const remove: string[] = [];
    for (const rel of relPaths) {
      const code = codeOf.get(rel);
      if (code === undefined) {
        continue;
      }
      const plan = resolvePlan(code, side);
      if (plan.kind === 'checkout') {
        checkout.push(rel);
      } else if (plan.kind === 'stage') {
        stage.push(rel);
      } else {
        remove.push(rel);
      }
    }

    const cwd = this.repo.rootUri.fsPath;
    const cli = this.repo.cli;
    this.mutating = true;
    try {
      // (1) Check out the winning side's stage into the worktree.
      if (checkout.length > 0) {
        const flag = side === 'ours' ? '--ours' : '--theirs';
        if (checkout.length === 1 && checkout[0]) {
          await cli.runChecked(cwd, ['checkout', flag, '--', checkout[0].replace(/\\/g, '/')]);
        } else {
          await withPathspecFiles([checkout], (ps) => cli.runChecked(cwd, ['checkout', flag, ...pathspecArgs(ps)]));
        }
      }
      // (2) Staging collapses the unmerged stages to one stage-0 entry —
      // required after checkout too (checkout alone leaves the index unmerged).
      const toStage = [...checkout, ...stage];
      if (toStage.length > 0) {
        await withPathspecFiles([toStage], (ps) => cli.runChecked(cwd, ['add', '-f', ...pathspecArgs(ps)]));
      }
      // (3) Removals: delete from index AND worktree (modify/delete cases).
      if (remove.length > 0) {
        if (remove.length === 1 && remove[0]) {
          await cli.runChecked(cwd, ['rm', '-q', '--force', '--', remove[0].replace(/\\/g, '/')]);
        } else {
          await withPathspecFiles([remove], (ps) => cli.runChecked(cwd, ['rm', '-q', '--force', ...pathspecArgs(ps)]));
        }
      }
      await this.refresh();
    } finally {
      this.mutating = false;
    }
  }

  /**
   * Finishes the operation with a PLAIN commit — `--only` is fatal while a
   * merge is in progress, and the index already holds exactly the merge
   * result. Guard: refuses while conflicts remain (defense in depth; the
   * command layer blocks earlier to show the "N conflict(s) remain" info).
   */
  async completeMerge(message: string): Promise<void> {
    if (!this.snapshotValue) {
      throw new Error('no merge operation is in progress');
    }
    if (this.snapshotValue.conflicts.length > 0) {
      throw new Error(`${this.snapshotValue.conflicts.length} conflict(s) remain unresolved`);
    }
    const msgFile = await TempTextFile.create(message);
    try {
      await this.repo.cli.runChecked(this.repo.rootUri.fsPath, ['commit', `--file=${msgFile.path}`]);
    } finally {
      await msgFile.dispose();
    }
    await this.refresh();
  }

  /**
   * Concludes an in-progress rebase. `core.editor=true` makes git's editor
   * invocation a no-op (`true` is the shell command) — without this guard
   * rebase --continue would hang the extension host waiting on an editor.
   */
  async continueRebase(): Promise<void> {
    await this.repo.cli.runChecked(this.repo.rootUri.fsPath, ['-c', 'core.editor=true', 'rebase', '--continue']);
    await this.refresh();
  }

  /** Aborts the in-progress operation with the argv its state requires. */
  async abort(): Promise<void> {
    const operation = this.snapshotValue?.operation ?? 'unknown';
    const argv: Record<Exclude<MergeOperation, 'unknown'>, string[]> = {
      merge: ['merge', '--abort'],
      'cherry-pick': ['cherry-pick', '--abort'],
      revert: ['revert', '--abort'],
      rebase: ['rebase', '--abort'],
    };
    const args = argv[operation as Exclude<MergeOperation, 'unknown'>];
    if (!args) {
      throw new Error('no merge operation is in progress');
    }
    this.mutating = true;
    try {
      await this.repo.cli.runChecked(this.repo.rootUri.fsPath, args);
      await this.refresh();
    } finally {
      this.mutating = false;
    }
  }

  /** The staged message git left for the operation (MERGE_MSG), or ''. */
  readMergeMessage(): string {
    if (this.gitDir === '') {
      return '';
    }
    try {
      return fs.readFileSync(path.join(this.gitDir, 'MERGE_MSG'), 'utf8').replace(/\r?\n$/, '');
    } catch {
      return '';
    }
  }

  dispose(): void {
    this.refreshDebounced.cancel();
    this.stateListener.dispose();
    this.changeEmitter.dispose();
  }
}
