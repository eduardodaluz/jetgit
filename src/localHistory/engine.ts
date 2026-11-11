/**
 * Local History snapshot engine — watcher-driven, NEVER blocks a save.
 * Invariant (product-defining): every hook is async fire-and-forget and
 * swallows errors into the log; a snapshot failure can never surface to the
 * user or delay a save by even a millisecond.
 *
 * Primary driver: FileSystemWatcher (covers saves AND external edits).
 * Secondary: onDidSaveTextDocument (watcher latency can be 1–2 s).
 * Deletes: tombstones — the previous snapshot is the recovery source.
 * Directory deletes: tombstone every indexed child under it (recursive
 * delete events are not individually reported by the watcher).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { debounce } from '../common/async';
import { looksBinary, readHead, sha256 } from '../common/fsutil';
import { keyForAbs } from '../common/paths';
import { debug, error } from '../common/log';
import { applyRetention } from './model';
import { dataKeyFor, LocalHistoryStore } from './store';

export interface EngineOptions {
  maxFileSizeKB: number;
  debounceMs: number;
  retentionDays: number;
  maxPerFile: number;
  /** Absolute directory prefixes to skip (e.g. .git dirs, globalStorage). */
  excludedPrefixes: string[];
}

export class LocalHistoryEngine {
  private readonly perFileChecks = new Map<string, ((immediate?: boolean) => void) & { cancel(): void }>();
  private readonly retentionSweep: ((...args: []) => void) & { cancel(): void };
  private disposed = false;

  constructor(
    private readonly store: LocalHistoryStore,
    private readonly options: () => EngineOptions,
  ) {
    this.retentionSweep = debounce(() => void this.sweepRetention(), 30_000);
  }

  /** Attaches to a watcher + save events. Returns the disposable set. */
  attach(watcher: vscode.FileSystemWatcher, onDidSave: vscode.Event<vscode.TextDocument>): vscode.Disposable {
    const disposables: Array<{ dispose(): unknown }> = [
      watcher.onDidChange((uri) => this.scheduleCheck(uri)),
      watcher.onDidCreate((uri) => this.scheduleCheck(uri)),
      watcher.onDidDelete((uri) => void this.handleDelete(uri)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === 'file') {
          this.scheduleCheck(doc.uri, true);
        }
      }),
    ];
    return {
      dispose: () => {
        this.disposed = true;
        for (const d of disposables) {
          d.dispose();
        }
        for (const cancelable of this.perFileChecks.values()) {
          cancelable.cancel();
        }
        this.perFileChecks.clear();
        this.retentionSweep.cancel();
      },
    };
  }

  private scheduleCheck(uri: vscode.Uri, immediate = false): void {
    if (this.disposed || uri.scheme !== 'file') {
      return;
    }
    const key = keyForAbs(uri.fsPath);
    let debounced = this.perFileChecks.get(key);
    if (!debounced) {
      debounced = debounce(() => void this.checkFile(uri.fsPath), this.options().debounceMs);
      this.perFileChecks.set(key, debounced);
    }
    if (immediate) {
      // Save hook: bypass the debounce (watcher latency would double the wait).
      debounced.cancel();
      void this.checkFile(uri.fsPath);
      return;
    }
    debounced();
  }

  /** Dedupes against the last recorded sha256; snapshots only real changes. */
  private async checkFile(fsPath: string): Promise<void> {
    try {
      const opts = this.options();
      if (isExcluded(fsPath, opts.excludedPrefixes)) {
        return;
      }
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath)).then(
        (s) => s,
        () => undefined,
      );
      if (!stat || (stat.type & vscode.FileType.File) === 0) {
        return;
      }
      if (stat.size > opts.maxFileSizeKB * 1024) {
        return;
      }
      const head = await readHead(fsPath);
      if (looksBinary(head)) {
        return;
      }
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
      const hash = sha256(Buffer.from(content));
      const known = await this.store.get();
      const record = known.files[dataKeyFor(fsPath)];
      if (record?.entries[0]?.sha256 === hash) {
        return; // unchanged since last snapshot
      }
      await this.store.recordSnapshot(fsPath, Buffer.from(content));
      this.retentionSweep();
    } catch (err) {
      // Product invariant: snapshotting NEVER surfaces an error to the user.
      debug(`localHistory: snapshot check failed for ${fsPath}`);
      error('localHistory: snapshot failed', err);
    }
  }

  private async handleDelete(uri: vscode.Uri): Promise<void> {
    try {
      if (uri.scheme !== 'file' || isExcluded(uri.fsPath, this.options().excludedPrefixes)) {
        return;
      }
      const stillThere = await vscode.workspace.fs.stat(uri).then(
        (s) => s,
        () => undefined,
      );
      if (stillThere) {
        return; // recreate race — the change handler owns it
      }
      const key = dataKeyFor(uri.fsPath);
      const index = await this.store.get();
      if (index.files[key]) {
        await this.store.recordTombstone(uri.fsPath);
        return;
      }
      // Directory delete: tombstone every indexed child under it.
      const prefix = keyForAbs(uri.fsPath) + '/';
      for (const [childKey, record] of Object.entries(index.files)) {
        void childKey;
        if (keyForAbs(record.path).startsWith(prefix) && !record.entries[0]?.deleted) {
          await this.store.recordTombstone(record.path);
        }
      }
    } catch (err) {
      error('localHistory: tombstone failed', err);
    }
  }

  /** Retention sweep: delegates rules to the pure, unit-tested applyRetention. */
  private async sweepRetention(): Promise<void> {
    try {
      const index = await this.store.get();
      const opts = this.options();
      const retention = { retentionDays: opts.retentionDays, maxPerFile: opts.maxPerFile };
      for (const [key, record] of Object.entries(index.files)) {
        const result = applyRetention(record, Date.now(), retention);
        if (result.purgeFile) {
          await this.store.purgeFile(key);
        } else if (result.dropIds.length > 0) {
          await this.store.dropEntries(key, result.dropIds);
        }
      }
    } catch (err) {
      error('localHistory: retention sweep failed', err);
    }
  }
}

function isExcluded(fsPath: string, prefixes: string[]): boolean {
  const norm = path.posix.normalize(fsPath.replace(/\\/g, '/')).toLowerCase();
  return prefixes.some((p) => {
    const np = p.replace(/\\/g, '/').toLowerCase();
    return norm === np || norm.startsWith(np.endsWith('/') ? np : np + '/');
  }) || norm.includes('/.git/');
}
