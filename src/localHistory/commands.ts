/**
 * Local History commands + engine lifecycle. Works with or without git:
 * this module never touches the git bridge.
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DisposableCollection } from '../common/async';
import { keyForAbs } from '../common/paths';
import { mkdirpSync } from '../common/fsutil';
import { showError } from '../common/log';
import { settings } from '../common/settingsInstance';
import { looksBinary } from '../common/fsutil';
import { Strings } from '../strings';
import { dataKeyFor, LocalHistoryStore } from './store';
import { LocalHistoryEngine } from './engine';
import { LocalHistoryContentProvider, historyUri } from './contentProvider';
import { registerLocalHistoryTimeline } from './timeline';

export class LocalHistoryController {
  private readonly store: LocalHistoryStore;
  private readonly disposables = new DisposableCollection();

  constructor(context: vscode.ExtensionContext) {
    const wsSeed = (context.storageUri ?? context.globalStorageUri).fsPath;
    const wsHash = createHash('sha1').update(keyForAbs(wsSeed), 'utf8').digest('hex').slice(0, 16);
    const root = path.join(context.globalStorageUri.fsPath, 'localHistory', wsHash);
    this.store = new LocalHistoryStore(root);

    // Content provider for jetgit-history: diffs.
    this.disposables.add(
      vscode.workspace.registerTextDocumentContentProvider('jetgit-history', new LocalHistoryContentProvider(this.store)),
    );

    // Engine: one workspace-wide watcher + save hook.
    const engineOptions = () => {
      const s = settings().value.localHistory;
      return {
        maxFileSizeKB: s.maxFileSizeKB,
        debounceMs: s.debounceMs,
        retentionDays: s.retentionDays,
        maxPerFile: s.maxSnapshotsPerFile,
        excludedPrefixes: [context.globalStorageUri.fsPath, context.extensionUri.fsPath],
      };
    };
    const engine = new LocalHistoryEngine(this.store, engineOptions);
    const watcher = vscode.workspace.createFileSystemWatcher('**');
    this.disposables.add(watcher);
    this.disposables.add(engine.attach(watcher, vscode.workspace.onDidSaveTextDocument));

    // Native Timeline tab per file (capability-guarded; optional).
    const timelineDisposable = registerLocalHistoryTimeline(this.store);
    if (timelineDisposable) {
      this.disposables.add(timelineDisposable);
    }

    this.registerCommands();
  }

  private registerCommands(): void {
    const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
      this.disposables.add(vscode.commands.registerCommand(command, handler));
    };

    register('jetgit.localHistory.putLabel', async (node: unknown) => {
      const fileUri = this.targetFile(node);
      if (!fileUri) {
        return;
      }
      try {
        const label = await vscode.window.showInputBox({ prompt: Strings.localHistory.labelPrompt, ignoreFocusOut: true });
        if (label === undefined || label.trim().length === 0) {
          return;
        }
        const content = await fsp.readFile(fileUri.fsPath);
        const key = dataKeyFor(fileUri.fsPath);
        const record = (await this.store.get()).files[key];
        const newest = record?.entries[0];
        if (newest && !newest.deleted && newest.sha256 === sha256(content)) {
          // Content already snapshotted — just label it.
          newest.label = label.trim();
          this.store.set(await this.store.get());
          await this.store.flush();
        } else {
          await this.store.recordSnapshot(fileUri.fsPath, Buffer.from(content), label.trim());
        }
        void vscode.window.showInformationMessage(
          Strings.localHistory.labelApplied.replace('{file}', path.basename(fileUri.fsPath)),
        );
      } catch (err) {
        showError('Put Label failed', err);
      }
    });

    register('jetgit.localHistory.restore', async (node: unknown) => {
      const fileUri = this.targetFile(node);
      if (!fileUri) {
        return;
      }
      try {
        const key = dataKeyFor(fileUri.fsPath);
        const record = (await this.store.get()).files[key];
        const entries = (record?.entries ?? []).filter((e) => !e.deleted);
        if (entries.length === 0) {
          void vscode.window.showInformationMessage(Strings.localHistory.noHistory);
          return;
        }
        const picked = await vscode.window.showQuickPick(
          entries.map((e) => ({
            label: e.label ?? new Date(e.ts).toLocaleString(),
            description: e.label ? new Date(e.ts).toLocaleString() : `${e.bytes} bytes`,
            entry: e,
          })),
          { placeHolder: Strings.localHistory.entryPickPrompt },
        );
        if (!picked) {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          Strings.localHistory.restoreConfirm
            .replace('{file}', path.basename(fileUri.fsPath))
            .replace('{time}', new Date(picked.entry.ts).toLocaleString()),
          { modal: true, detail: Strings.localHistory.safetyNote },
          'Restore',
        );
        if (confirm !== 'Restore') {
          return;
        }
        await this.restoreEntry(fileUri, key, picked.entry.id);
        void vscode.window.showInformationMessage(
          Strings.localHistory.restoredInfo
            .replace('{file}', path.basename(fileUri.fsPath))
            .replace('{time}', new Date(picked.entry.ts).toLocaleString()),
        );
      } catch (err) {
        showError('Restore failed', err);
      }
    });

    register('jetgit.localHistory.showDiff', async (node: unknown) => {
      const fileUri = this.targetFile(node);
      if (!fileUri) {
        return;
      }
      try {
        const key = dataKeyFor(fileUri.fsPath);
        const record = (await this.store.get()).files[key];
        const entries = (record?.entries ?? []).filter((e) => !e.deleted);
        if (entries.length === 0) {
          void vscode.window.showInformationMessage(Strings.localHistory.noHistory);
          return;
        }
        const picked = await vscode.window.showQuickPick(
          entries.map((e) => ({
            label: e.label ?? new Date(e.ts).toLocaleString(),
            description: e.label ? new Date(e.ts).toLocaleString() : `${e.bytes} bytes`,
            entry: e,
          })),
          { placeHolder: Strings.localHistory.entryPickPrompt },
        );
        if (!picked) {
          return;
        }
        await vscode.commands.executeCommand(
          'vscode.diff',
          historyUri(fileUri, { key, entryId: picked.entry.id }),
          fileUri,
          `${path.basename(fileUri.fsPath)} — ${picked.label ?? new Date(picked.entry.ts).toLocaleString()} ↔ working tree`,
        );
      } catch (err) {
        showError('Local History diff failed', err);
      }
    });

    // Direct entry-point from the Timeline view (uri + entry handed over).
    register('jetgit.localHistory.showDiffFor', async (...args: unknown[]) => {
      const [uriArg, keyArg, entryArg] = args as [vscode.Uri | undefined, string | undefined, string | undefined];
      if (uriArg?.scheme !== 'file' || !keyArg || !entryArg) {
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        historyUri(uriArg, { key: keyArg, entryId: entryArg }),
        uriArg,
        `${path.basename(uriArg.fsPath)} — Local History ↔ working tree`,
      );
    });

    register('jetgit.localHistory.restoreDeleted', async () => {
      try {
        const tombstoned = await this.store.tombstonedPaths();
        if (tombstoned.length === 0) {
          void vscode.window.showInformationMessage(Strings.localHistory.noDeleted);
          return;
        }
        const picked = await vscode.window.showQuickPick(
          tombstoned.map((t) => ({
            label: path.basename(t.path),
            description: t.path,
            detail: new Date(t.lastEntry.ts).toLocaleString(),
            target: t,
          })),
          { placeHolder: Strings.localHistory.deletedPickPrompt },
        );
        if (!picked) {
          return;
        }
        const record = (await this.store.get()).files[picked.target.key];
        const lastContentEntry = record?.entries.find((e) => !e.deleted);
        if (!record || !lastContentEntry) {
          void vscode.window.showWarningMessage(`No snapshot content found for ${picked.label}.`);
          return;
        }
        const fileUri = vscode.Uri.file(record.path);
        const confirm = await vscode.window.showWarningMessage(
          Strings.localHistory.restoreConfirm
            .replace('{file}', path.basename(record.path))
            .replace('{time}', new Date(lastContentEntry.ts).toLocaleString()),
          { modal: true },
          'Restore',
        );
        if (confirm !== 'Restore') {
          return;
        }
        await this.restoreEntry(fileUri, picked.target.key, lastContentEntry.id);
        void vscode.window.showInformationMessage(
          Strings.localHistory.recreatedInfo.replace('{file}', path.basename(record.path)),
        );
      } catch (err) {
        showError('Restore deleted file failed', err);
      }
    });

    register('jetgit.localHistory.clear', async () => {
      const confirm = await vscode.window.showWarningMessage(Strings.localHistory.clearConfirm, { modal: true }, 'Clear All');
      if (confirm !== 'Clear All') {
        return;
      }
      try {
        await this.store.clearAll();
        void vscode.window.showInformationMessage(Strings.localHistory.clearedInfo);
      } catch (err) {
        showError('Clear Local History failed', err);
      }
    });

    register('jetgit.localHistory.storageUsage', async () => {
      try {
        const usage = await this.store.storageUsage();
        const size = formatBytes(usage.totalBytes);
        const top = usage.top.map((t) => `${path.basename(t.path)} (${formatBytes(t.bytes)}, ${t.count})`).join(', ');
        void vscode.window.showInformationMessage(
          Strings.localHistory.usageSummary
            .replace('{files}', usage.files.toString())
            .replace('{snapshots}', usage.snapshots.toString())
            .replace('{size}', size)
            .replace('{top}', top || '—'),
          { modal: true },
        );
      } catch (err) {
        showError('Storage usage failed', err);
      }
    });
  }

  /** Safety-snapshots current content, then writes the historical content back. */
  private async restoreEntry(fileUri: vscode.Uri, key: string, entryId: string): Promise<void> {
    const content = await this.store.readSnapshot(key, entryId);
    if (content === undefined) {
      throw new Error(`snapshot ${entryId} unavailable`);
    }
    // Safety snapshot of whatever exists now (skip when file is absent).
    const exists = await fsp.access(fileUri.fsPath).then(() => true, () => false);
    if (exists) {
      const current = await fsp.readFile(fileUri.fsPath);
      if (!looksBinary(current.subarray(0, 8192))) {
        await this.store.recordSnapshot(fileUri.fsPath, current);
      }
    }
    mkdirpSync(path.dirname(fileUri.fsPath));
    await fsp.writeFile(fileUri.fsPath, content);
    if (!exists) {
      // Recreated file: record that we know about it again is unnecessary —
      // the watcher will pick it up; opening helps the user verify.
      const doc = await vscode.workspace.openTextDocument(fileUri).then(
        (d) => d,
        () => undefined,
      );
      if (doc) {
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    }
  }

  private targetFile(node: unknown): vscode.Uri | undefined {
    if (node instanceof vscode.Uri && node.scheme === 'file') {
      return node;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      return editor.document.uri;
    }
    void vscode.window.showInformationMessage(Strings.localHistory.noHistory);
    return undefined;
  }

  dispose(): void {
    this.disposables.dispose();
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
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
