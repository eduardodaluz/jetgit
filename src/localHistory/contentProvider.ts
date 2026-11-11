/**
 * Content provider for the `jetgit-history:` scheme: resolves any snapshot
 * as read-only document content, enabling native diff editors between any
 * two points in time — including restoring deleted files (diff of a
 * snapshot against nothing).
 */
import * as vscode from 'vscode';
import type { LocalHistoryStore } from './store';

export const HISTORY_SCHEME = 'jetgit-history';

export interface HistoryRef {
  /** dataKey of the file. */
  key: string;
  entryId: string;
}

export function historyUri(fileUri: vscode.Uri, ref: HistoryRef): vscode.Uri {
  return fileUri.with({
    scheme: HISTORY_SCHEME,
    query: Buffer.from(JSON.stringify(ref), 'utf8').toString('base64'),
  });
}

export function parseHistoryUri(uri: vscode.Uri): HistoryRef | undefined {
  try {
    const ref = JSON.parse(Buffer.from(uri.query, 'base64').toString('utf8')) as HistoryRef;
    if (typeof ref.key === 'string' && typeof ref.entryId === 'string') {
      return ref;
    }
  } catch {
    // malformed uri — fall through
  }
  return undefined;
}

export class LocalHistoryContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly store: LocalHistoryStore) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = parseHistoryUri(uri);
    if (!ref) {
      return `<!-- JetGit: malformed local history reference -->`;
    }
    const content = await this.store.readSnapshot(ref.key, ref.entryId);
    if (content === undefined) {
      return `<!-- JetGit: local history snapshot ${ref.entryId} is unavailable (expired or purged) -->`;
    }
    return Buffer.from(content).toString('utf8');
  }
}
