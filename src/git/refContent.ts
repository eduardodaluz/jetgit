/**
 * Content provider for the `jetgit-ref:` scheme: read-only content of a path
 * at a ref (`git show <ref>:<path>`), used by blame "Open Commit" diffs and
 * (M6) branch compare. Binary content is decoded as UTF-8 — the text document
 * content provider contract accepts strings only; image-side diffs are
 * post-MVP.
 */
import * as vscode from 'vscode';
import type { GitApiService } from './gitApi';

export const REF_SCHEME = 'jetgit-ref';

interface RefUriPayload {
  /** RepoHandle identity: rootUri.toString() */
  repo: string;
  ref: string;
  relPath: string;
}

export function refUri(repoRootUri: vscode.Uri, ref: string, relPath: string): vscode.Uri {
  const payload: RefUriPayload = { repo: repoRootUri.toString(), ref, relPath };
  return vscode.Uri.from({
    scheme: REF_SCHEME,
    // Leading '/' keeps the URI well-formed; relPath is carried in the payload.
    path: '/' + relPath,
    query: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  });
}

export function parseRefUri(uri: vscode.Uri): RefUriPayload | undefined {
  try {
    const payload = JSON.parse(Buffer.from(uri.query, 'base64').toString('utf8')) as RefUriPayload;
    if (typeof payload.repo === 'string' && typeof payload.ref === 'string' && typeof payload.relPath === 'string') {
      return payload;
    }
  } catch {
    // malformed uri — fall through
  }
  return undefined;
}

export class RefContentProvider implements vscode.TextDocumentContentProvider {
  /**
   * Executes a read-only git command inside the repo identified by
   * `repoKey` (a RepoHandle rootUri string); resolves cwd and binary itself.
   */
  constructor(private readonly runReadOnlyInRepo: (repoKey: string, args: string[]) => Promise<Buffer>) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const payload = parseRefUri(uri);
    if (!payload) {
      return '<!-- JetGit: malformed ref reference -->';
    }
    try {
      const stdout = await this.runReadOnlyInRepo(payload.repo, ['show', `${payload.ref}:${payload.relPath}`]);
      return stdout.toString('utf8');
    } catch (err) {
      return `<!-- JetGit: ${payload.relPath} is not available at ${payload.ref} (${err instanceof Error ? err.message : String(err)}) -->`;
    }
  }
}

/** Registers the provider against the live repo set (M5 blame + M6 compare). */
export function registerRefContentProvider(gitApi: GitApiService): vscode.Disposable {
  const provider = new RefContentProvider(async (repoKey, args) => {
    const repo = gitApi.repositories.find((r) => r.rootUri.toString() === repoKey);
    if (!repo) {
      throw new Error('repository is no longer open');
    }
    return repo.cli.runReadOnlyChecked(repo.rootUri.fsPath, args);
  });
  return vscode.workspace.registerTextDocumentContentProvider(REF_SCHEME, provider);
}
