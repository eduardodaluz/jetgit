/**
 * Shared "files of a commit → pick one → diff ref~1 vs ref" flow, used by
 * blame's hover Open Commit and the compare tree's commit nodes. Diffs run
 * over the `jetgit-ref:` scheme (text content only — see refContent).
 */
import * as vscode from 'vscode';
import { Strings } from '../strings';
import type { CommitFile } from './nameStatus';
import { refUri } from './refContent';

const STATUS_LABELS: Record<string, string> = {
  A: Strings.blame.statusAdded,
  M: Strings.blame.statusModified,
  D: Strings.blame.statusDeleted,
  R: Strings.blame.statusRenamed,
  C: Strings.blame.statusCopied,
  T: Strings.blame.statusTypeChanged,
};

export async function showCommitFileDiffPicker(
  repoRootUri: vscode.Uri,
  sha: string,
  files: readonly CommitFile[],
  summary: string | undefined,
  prompt: string,
): Promise<void> {
  if (files.length === 0) {
    void vscode.window.showInformationMessage(Strings.blame.noFilesInCommit);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    files.map((f) => ({
      label: f.path,
      description: STATUS_LABELS[f.status] ?? f.status,
      detail: f.oldPath,
      file: f,
    })),
    { placeHolder: prompt.replace('{sha}', sha.slice(0, 8)).replace('{summary}', summary ?? '') },
  );
  if (!picked) {
    return;
  }
  const left = refUri(repoRootUri, `${sha}~1`, picked.file.oldPath ?? picked.file.path);
  const right = refUri(repoRootUri, sha, picked.file.path);
  const title = `${picked.file.path} — ${sha.slice(0, 8)}${summary ? ` (${summary})` : ''}`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}
