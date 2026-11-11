/**
 * Blame service: resolves the repository for a document, runs blame/commit
 * queries via the git CLI, and keeps small caches keyed by HEAD + document
 * state so repeated decorations never re-run git. Silent failure: blame is a
 * decoration aid — any error (untracked file, bare repo, huge file) degrades
 * to "no annotation", logged at debug level only.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { debug } from '../common/log';
import { settings } from '../common/settingsInstance';
import type { GitApiService, RepoHandle } from '../git/gitApi';
import type { BlameResult } from '../git/blameParser';
import type { BlameAdapter, CommitFile, CommitInfo } from './blameQuery';
import { blameFile, blameLine, commitBody, commitFiles, commitInfo } from './blameQuery';

/** Adapter over a real RepoHandle (same shape the tests fake with a sandbox). */
function adapterFor(repo: RepoHandle): BlameAdapter {
  return {
    cwd: () => repo.rootUri.fsPath,
    runReadOnly: async (args) => repo.cli.runReadOnly(repo.rootUri.fsPath, args),
  };
}

interface LineCacheEntry {
  /** cache key: documentVersion|headSha|line */
  key: string;
  result: BlameResult;
}

interface FileCacheEntry {
  mtimeMs: number;
  headSha: string;
  result: BlameResult;
}

export class BlameService {
  private readonly lineCache = new Map<string, LineCacheEntry>();
  private readonly fileCache = new Map<string, FileCacheEntry>();
  private readonly bodyCache = new Map<string, string>();
  private readonly infoCache = new Map<string, CommitInfo | undefined>();

  constructor(private readonly gitApi: GitApiService) {}

  /** Per-line blame for an open document; cached per (version, HEAD, line). */
  async blameLine(uri: vscode.Uri, documentVersion: number, line: number): Promise<BlameResult | undefined> {
    const repo = this.gitApi.getRepoForUri(uri);
    if (!repo) {
      return undefined;
    }
    const headSha = repo.api.state.HEAD?.commit ?? 'no-head';
    const key = `${documentVersion}|${headSha}|${line}`;
    const cacheKey = uri.fsPath;
    const cached = this.lineCache.get(cacheKey);
    if (cached && cached.key === key) {
      return cached.result;
    }
    try {
      const rel = this.relPath(repo, uri.fsPath);
      const result = await blameLine(adapterFor(repo), rel, line, {
        ignoreWhitespace: settings().value.blame.ignoreWhitespace,
      });
      this.lineCache.set(cacheKey, { key, result });
      return result;
    } catch (err) {
      debug(`blame line failed for ${uri.fsPath}:${line} — ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Whole-file blame; size-capped, cached per (mtime, HEAD). */
  async blameFile(uri: vscode.Uri): Promise<BlameResult | undefined> {
    const repo = this.gitApi.getRepoForUri(uri);
    if (!repo) {
      return undefined;
    }
    const headSha = repo.api.state.HEAD?.commit ?? 'no-head';
    let stat: { mtimeMs: number; size: number };
    try {
      stat = await fsp.stat(uri.fsPath);
    } catch {
      return undefined;
    }
    const maxBytes = settings().value.blame.maxFileSizeKB * 1024;
    if (stat.size > maxBytes) {
      debug(`blame skipped (file exceeds ${maxBytes} bytes): ${uri.fsPath}`);
      return undefined;
    }
    const cached = this.fileCache.get(uri.fsPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.headSha === headSha) {
      return cached.result;
    }
    try {
      const rel = this.relPath(repo, uri.fsPath);
      const result = await blameFile(adapterFor(repo), rel, {
        ignoreWhitespace: settings().value.blame.ignoreWhitespace,
      });
      this.fileCache.set(uri.fsPath, { mtimeMs: stat.mtimeMs, headSha, result });
      return result;
    } catch (err) {
      debug(`blame file failed for ${uri.fsPath} — ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Full body of a commit (hover detail), cached per repo+sha. */
  async commitBody(repo: RepoHandle, sha: string): Promise<string | undefined> {
    const key = `${repo.rootUri.fsPath}|${sha}`;
    const cached = this.bodyCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const body = await commitBody(adapterFor(repo), sha);
      this.bodyCache.set(key, body);
      return body;
    } catch (err) {
      debug(`commit body failed for ${sha} — ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Display fields of a commit, cached per repo+sha (undefined = unknown). */
  async commitInfo(repo: RepoHandle, sha: string): Promise<CommitInfo | undefined> {
    const key = `${repo.rootUri.fsPath}|${sha}`;
    if (this.infoCache.has(key)) {
      return this.infoCache.get(key);
    }
    try {
      const info = await commitInfo(adapterFor(repo), sha);
      this.infoCache.set(key, info);
      return info;
    } catch (err) {
      debug(`commit info failed for ${sha} — ${err instanceof Error ? err.message : String(err)}`);
      this.infoCache.set(key, undefined);
      return undefined;
    }
  }

  /** Files touched by a commit (Open Commit picker). */
  async commitFiles(repo: RepoHandle, sha: string): Promise<CommitFile[]> {
    try {
      return await commitFiles(adapterFor(repo), sha);
    } catch (err) {
      debug(`commit files failed for ${sha} — ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Content of relPath at ref (binary-safe Buffer); undefined when missing. */
  async refContent(repo: RepoHandle, ref: string, relPath: string): Promise<Buffer | undefined> {
    try {
      const result = await adapterFor(repo).runReadOnly(['show', `${ref}:${relPath}`]);
      return result.code === 0 ? result.stdout : undefined;
    } catch (err) {
      debug(`show ${ref}:${relPath} failed — ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Evicts every cache (repo state changed in a way HEAD can't express, e.g. branch switch race). */
  invalidate(): void {
    this.lineCache.clear();
    this.fileCache.clear();
    this.bodyCache.clear();
    this.infoCache.clear();
  }

  private relPath(repo: RepoHandle, fsPath: string): string {
    return path.relative(repo.rootUri.fsPath, fsPath).replace(/\\/g, '/');
  }

  dispose(): void {
    this.invalidate();
  }
}
