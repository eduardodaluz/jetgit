/**
 * M6.5 commit-review commands: openDiff (HEAD ↔ live working file — the
 * right pane is a real editor, so reviewing and editing happen in one tab),
 * rollbackSelected (partial rollback of the hunks under the selection back
 * to HEAD via one WorkspaceEdit), rollbackFile (whole file: worktree ←
 * index, untracked → deleted), openFile.
 *
 * The rollback pipeline diffs the BUFFER text (not the disk) against HEAD
 * bytes through `git diff --no-index` over two temp files, so line numbers
 * match even with unsaved edits and the zero-deps rule holds: git is the
 * diff engine. The index is never touched — staged work survives by
 * construction.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DisposableCollection } from '../common/async';
import { looksBinary } from '../common/fsutil';
import { showError } from '../common/log';
import { settings } from '../common/settingsInstance';
import type { GitApiService, RepoHandle } from '../git/gitApi';
import { refContent } from '../blame/blameQuery';
import { EMPTY_REF, REF_SCHEME, parseRefUri, refUri } from '../git/refContent';
import { literalPathspec } from '../shelf/patchBuilder';
import { Strings } from '../strings';
import type { ChangesReviewController } from './review';
import { diffWorktreeVsHead } from './partialCommit';
import { computeRollbackEdits, toLf, type LineEdit, type LineSelection, type RollbackAdapter, type SelectionSpace } from './rollbackQuery';

const BINARY_SNIFF_BYTES = 8192;

function adapterFor(repo: RepoHandle): RollbackAdapter {
  return {
    cwd: () => repo.rootUri.fsPath,
    runReadOnly: async (args) => repo.cli.runReadOnly(repo.rootUri.fsPath, args),
  };
}

/**
 * LineEdits (LF domain, whole-line regions) → TextEdits for this document.
 * Document-end edits anchor at positionAt(text length) so trailing-newline
 * transitions round-trip; every other edit spans [start of line s, start of
 * line e). LF is re-applied as the document's EOL.
 */
export function toTextEdits(document: vscode.TextDocument, edits: readonly LineEdit[]): vscode.TextEdit[] {
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const docEnd = document.positionAt(document.getText().length);
  return edits.map((edit) => {
    let range: vscode.Range;
    if (edit.touchesDocumentEnd) {
      const start =
        edit.endLineExclusive > edit.startLine && edit.startLine < document.lineCount
          ? document.lineAt(edit.startLine).range.start
          : docEnd;
      range = new vscode.Range(start, docEnd);
    } else if (edit.endLineExclusive === edit.startLine) {
      const at = document.lineAt(Math.min(edit.startLine, document.lineCount - 1)).range.start;
      range = new vscode.Range(at, at);
    } else {
      const start = document.lineAt(edit.startLine).range.start;
      const end =
        edit.endLineExclusive < document.lineCount ? document.lineAt(edit.endLineExclusive).range.start : docEnd;
      range = new vscode.Range(start, end);
    }
    return vscode.TextEdit.replace(range, edit.text.replace(/\n/g, eol));
  });
}

interface ChangeNodePayload {
  repoKey: string;
  relPath: string;
  rootFsPath?: string;
}

function asChangeNode(nodeArg: unknown): ChangeNodePayload | undefined {
  const node = nodeArg as ChangeNodePayload | undefined;
  return node && typeof node === 'object' && typeof node.repoKey === 'string' && typeof node.relPath === 'string'
    ? node
    : undefined;
}

/** Built-in parity: a selection ending at column 0 does not include its last line. */
function normalizeSelection(selection: vscode.Selection): LineSelection {
  const first = Math.min(selection.start.line, selection.end.line);
  const last = Math.max(selection.start.line, selection.end.line);
  return { first, last: selection.end.character === 0 && last > first ? last - 1 : last };
}

export function registerChangesCommands(gitApi: GitApiService, review?: ChangesReviewController): vscode.Disposable {
  const disposables = new DisposableCollection();
  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    disposables.add(vscode.commands.registerCommand(command, handler));
  };

  const findRepoByKey = (repoKey: string): RepoHandle | undefined =>
    gitApi.repositories.find((r) => r.rootUri.toString() === repoKey);

  const relPathOf = (repo: RepoHandle, fileUri: vscode.Uri): string =>
    path.relative(repo.rootUri.fsPath, fileUri.fsPath).replace(/\\/g, '/');

  const maxBytes = (): number => settings().value.changes.maxFileSizeKB * 1024;

  register('jetgit.changes.openDiff', async (nodeArg: unknown) => {
    let repo: RepoHandle | undefined;
    let relPath: string;
    let fileUri: vscode.Uri;
    const node = asChangeNode(nodeArg);
    if (node) {
      repo = findRepoByKey(node.repoKey);
      if (!repo) {
        return;
      }
      relPath = node.relPath;
      fileUri = vscode.Uri.joinPath(repo.rootUri, relPath);
    } else {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file') {
        return;
      }
      repo = gitApi.getRepoForUri(uri);
      if (!repo) {
        return;
      }
      relPath = relPathOf(repo, uri);
      fileUri = uri;
    }
    try {
      const headBytes = await refContent(adapterFor(repo), 'HEAD', relPath);
      if (!headBytes) {
        // Untracked (or new-in-rename) — there is no HEAD version to diff against.
        await vscode.commands.executeCommand('vscode.open', fileUri);
        return;
      }
      if (looksBinary(headBytes.subarray(0, BINARY_SNIFF_BYTES))) {
        void vscode.window.showInformationMessage(Strings.changes.binaryInfo.replace('{path}', relPath));
        return;
      }
      let deleted = false;
      try {
        const stat = await fsp.stat(fileUri.fsPath);
        if (stat.size > maxBytes()) {
          void vscode.window.showInformationMessage(Strings.changes.tooLargeInfo.replace('{path}', relPath));
          return;
        }
      } catch {
        deleted = true; // locally deleted — full-width deletion diff
      }
      const left = refUri(repo.rootUri, 'HEAD', relPath);
      const right = deleted ? refUri(repo.rootUri, EMPTY_REF, relPath) : fileUri;
      // M6.7: opening the review diff (re)opens the hunk session from disk —
      // the diff's checkboxes drive the partial commit.
      if (review && !deleted) {
        await review.openSessionFor(repo, relPath, fileUri);
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        Strings.changes.diffTitle.replace('{path}', relPath),
      );
    } catch (err) {
      showError(Strings.changes.rollbackFailed, err);
    }
  });

  register('jetgit.changes.rollbackSelected', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(Strings.changes.notInDiffInfo);
      return;
    }
    const uri = editor.document.uri;
    let repo: RepoHandle | undefined;
    let space: SelectionSpace;
    let fileUri: vscode.Uri;
    if (uri.scheme === 'file') {
      repo = gitApi.getRepoForUri(uri);
      space = 'new';
      fileUri = uri;
    } else if (uri.scheme === REF_SCHEME) {
      const payload = parseRefUri(uri);
      // Only the HEAD left pane of a review diff may drive a rollback —
      // blame "Open Commit" and compare diffs share the scheme.
      if (!payload || payload.ref !== 'HEAD') {
        void vscode.window.showInformationMessage(Strings.changes.notInDiffInfo);
        return;
      }
      repo = findRepoByKey(payload.repo);
      space = 'old';
      fileUri = repo ? vscode.Uri.joinPath(repo.rootUri, payload.relPath) : uri;
    } else {
      void vscode.window.showInformationMessage(Strings.changes.notInDiffInfo);
      return;
    }
    if (!repo) {
      void vscode.window.showInformationMessage(Strings.changes.notInDiffInfo);
      return;
    }
    const relPath = relPathOf(repo, fileUri);
    const lineSelections = editor.selections.filter((s) => !s.isEmpty).map(normalizeSelection);
    const document = space === 'new' ? editor.document : await vscode.workspace.openTextDocument(fileUri);

    try {
      const adapter = adapterFor(repo);
      const headBytes = await refContent(adapter, 'HEAD', relPath);
      if (!headBytes) {
        void vscode.window.showInformationMessage(Strings.changes.untrackedRollbackInfo.replace('{path}', relPath));
        return;
      }
      const bufferBytes = Buffer.from(document.getText(), 'utf8');
      if (looksBinary(headBytes.subarray(0, BINARY_SNIFF_BYTES)) || looksBinary(bufferBytes.subarray(0, BINARY_SNIFF_BYTES))) {
        void vscode.window.showInformationMessage(Strings.changes.binaryInfo.replace('{path}', relPath));
        return;
      }
      if (bufferBytes.length > maxBytes()) {
        void vscode.window.showInformationMessage(Strings.changes.tooLargeInfo.replace('{path}', relPath));
        return;
      }

      let allHunks = false;
      let selections: readonly LineSelection[] = lineSelections;
      if (lineSelections.length === 0) {
        // Cursor without selection: offer the whole file instead.
        const choice = await vscode.window.showWarningMessage(
          Strings.changes.rollbackAllPrompt.replace('{path}', relPath),
          { modal: true },
          Strings.changes.rollbackAllButton,
        );
        if (choice !== Strings.changes.rollbackAllButton) {
          return;
        }
        allHunks = true;
        selections = [];
      }

      const headLf = toLf(headBytes.toString('utf8'));
      let text = document.getText();
      let version = document.version;
      let edits: readonly LineEdit[] | undefined;
      for (let attempt = 0; attempt < 2 && !edits; attempt++) {
        const hunks = await diffWorktreeVsHead(adapter, headBytes, text);
        const candidate = computeRollbackEdits(headLf, toLf(text), hunks, allHunks ? null : selections, space);
        if (candidate.length === 0) {
          void vscode.window.showInformationMessage(Strings.changes.noRollbackableChanges);
          return;
        }
        // TOCTOU: the user may have typed during the git round-trip. One
        // recompute from a fresh snapshot; drifting again aborts.
        if (document.version !== version) {
          if (attempt > 0) {
            void vscode.window.showInformationMessage(Strings.changes.changedDuringRollback.replace('{path}', relPath));
            return;
          }
          text = document.getText();
          version = document.version;
          continue;
        }
        edits = candidate;
      }
      if (!edits) {
        return;
      }

      const affectedLines = edits.reduce(
        (n, e) => n + (e.endLineExclusive > e.startLine ? e.endLineExclusive - e.startLine : e.text.split('\n').length - 1),
        0,
      );
      if (settings().value.changes.confirmRollback) {
        const choice = await vscode.window.showWarningMessage(
          Strings.changes.rollbackConfirm
            .replace('{hunks}', String(edits.length))
            .replace('{lines}', String(affectedLines))
            .replace('{path}', relPath),
          { modal: true, detail: Strings.changes.rollbackConfirmDetail },
          Strings.changes.rollbackButton,
        );
        if (choice !== Strings.changes.rollbackButton) {
          return;
        }
      }

      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.set(fileUri, toTextEdits(document, edits));
      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      if (!applied) {
        throw new Error('the editor rejected the rollback edit');
      }
      void vscode.window.showInformationMessage(
        Strings.changes.rolledBackInfo.replace('{hunks}', String(edits.length)).replace('{path}', relPath),
      );
    } catch (err) {
      showError(Strings.changes.rollbackFailed, err);
    }
  });

  register('jetgit.changes.rollbackFile', async (nodeArg: unknown) => {
    let repo: RepoHandle | undefined;
    let relPath: string;
    let fileUri: vscode.Uri;
    const node = asChangeNode(nodeArg);
    if (node) {
      repo = findRepoByKey(node.repoKey);
      if (!repo) {
        return;
      }
      relPath = node.relPath;
      fileUri = vscode.Uri.joinPath(repo.rootUri, relPath);
    } else {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file') {
        void vscode.window.showInformationMessage(Strings.changes.notInDiffInfo);
        return;
      }
      repo = gitApi.getRepoForUri(uri);
      if (!repo) {
        void vscode.window.showInformationMessage(Strings.changes.notInDiffInfo);
        return;
      }
      relPath = relPathOf(repo, uri);
      fileUri = uri;
    }
    try {
      const headBytes = await refContent(adapterFor(repo), 'HEAD', relPath);
      // A dirty editor open on this file would silently undo the checkout on
      // the next save — warn up front and reload it afterwards.
      const dirtyDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === fileUri.toString() && d.isDirty);
      if (!headBytes) {
        const confirm = await vscode.window.showWarningMessage(
          Strings.changes.rollbackFileUntrackedConfirm.replace('{path}', relPath),
          { modal: true },
          Strings.changes.deleteButton,
        );
        if (confirm !== Strings.changes.deleteButton) {
          return;
        }
        await repo.cli.runChecked(repo.rootUri.fsPath, ['clean', '-f', '--', literalPathspec(relPath)]);
        void vscode.window.showInformationMessage(Strings.changes.deletedInfo.replace('{path}', relPath));
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        Strings.changes.rollbackFileConfirm.replace('{path}', relPath),
        { modal: true, detail: dirtyDoc ? Strings.changes.rollbackFileDirtyDetail : undefined },
        Strings.changes.rollbackButton,
      );
      if (confirm !== Strings.changes.rollbackButton) {
        return;
      }
      // worktree ← index (staged content preserved; IntelliJ rollback parity).
      await repo.cli.runChecked(repo.rootUri.fsPath, ['checkout', '--', literalPathspec(relPath)]);
      if (dirtyDoc) {
        await vscode.window.showTextDocument(dirtyDoc);
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      void vscode.window.showInformationMessage(Strings.changes.rolledBackFileInfo.replace('{path}', relPath));
    } catch (err) {
      showError(Strings.changes.rollbackFailed, err);
    }
  });

  register('jetgit.changes.openFile', async (nodeArg: unknown) => {
    const node = asChangeNode(nodeArg);
    if (node && node.rootFsPath) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(`${node.rootFsPath}/${node.relPath}`));
      return;
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri && uri.scheme === 'file') {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  });

  return disposables;
}
