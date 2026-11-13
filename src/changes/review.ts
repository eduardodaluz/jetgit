/**
 * Review controller (M6.7): per-hunk commit inclusion in the change diff.
 * Owns the HunkSelectionStore, the CodeLens provider ("click to include/
 * exclude each changed hunk" + the N/M counter), the gutter decorations
 * showing inclusion state, and the partial-commit runner used by the
 * changelists service.
 *
 * VS Code has no interactive gutter checkboxes, so the CodeLens IS the
 * checkbox; the decoration keeps the state visible while scrolling. Sessions
 * persist without open editors (commit from the tree after closing the diff)
 * and are pruned by reconcile.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { debounce, DisposableCollection } from '../common/async';
import { looksBinary } from '../common/fsutil';
import type { GitApiService, RepoHandle } from '../git/gitApi';
import { refContent } from '../blame/blameQuery';
import { Strings } from '../strings';
import { effectiveSignatures, HunkSelectionStore, entryState } from './hunkSelection';
import { commitPartial, diffWorktreeVsHead, type PartialCommitRepo, type PartialPlan } from './partialCommit';
import {
  allUnitSignatures,
  computeChangeUnits,
  type ChangeUnit,
  type DiffHunk,
  type RollbackAdapter,
} from './rollbackQuery';

const BINARY_SNIFF_BYTES = 8192;

const CHECK_SVG_DARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><path d="M2 6.5l3 3 5-6.5" fill="none" stroke="#3fb950" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const CHECK_SVG_LIGHT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><path d="M2 6.5l3 3 5-6.5" fill="none" stroke="#1a7f37" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const BOX_SVG_DARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="#8b949e" stroke-width="1.2"/></svg>`;
const BOX_SVG_LIGHT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="#57606a" stroke-width="1.2"/></svg>`;

const svgUri = (svg: string): vscode.Uri => vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);

export class ChangesReviewController {
  private readonly store = new HunkSelectionStore();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires on any session/toggle change — the tree refreshes its labels. */
  readonly onDidChangeReview = this.changeEmitter.event;

  private readonly hunkCache = new Map<string, { version: number; hunks: DiffHunk[] }>();
  private readonly inFlight = new Map<string, Promise<DiffHunk[] | undefined>>();
  private readonly docDebounces = new Map<string, ((...args: []) => void) & { cancel(): void }>();
  private readonly disposables = new DisposableCollection();
  private includedType?: vscode.TextEditorDecorationType;
  private excludedType?: vscode.TextEditorDecorationType;
  private treeCheckedFn: ((repoKey: string, relPath: string) => boolean) | undefined;

  constructor(private readonly gitApi: GitApiService) {
    this.store.changeListener = () => {
      this.applyDecorations();
      this.changeEmitter.fire();
    };
  }

  /** Injected by the changelists controller: the whole-file tree checkbox. */
  attachTreeChecked(fn: (repoKey: string, relPath: string) => boolean): void {
    this.treeCheckedFn = fn;
  }

  // ------------------------------------------------------------------ sessions

  /** Opens (or refreshes) the review session for a file from its DISK state — the commit truth. */
  async openSessionFor(repo: RepoHandle, relPath: string, fileUri: vscode.Uri): Promise<void> {
    const repoKey = repo.rootUri.toString();
    try {
      const headBytes = await refContent(this.adapterFor(repo), 'HEAD', relPath);
      if (!headBytes || looksBinary(headBytes.subarray(0, BINARY_SNIFF_BYTES))) {
        return; // untracked/binary: whole-file only, no hunk session
      }
      const disk = await fsp.readFile(fileUri.fsPath);
      const hunks = await diffWorktreeVsHead(this.adapterFor(repo), headBytes, disk.toString('utf8'));
      if (hunks.length === 0) {
        this.store.closeSession(repoKey, relPath);
      } else {
        this.store.openSession(repoKey, relPath, allUnitSignatures(computeChangeUnits(hunks), hunks));
        this.hunkCache.delete(fileUri.toString()); // display recomputes against the live document
      }
    } catch (err) {
      // A missing checkbox row with NO error is a support puzzle — surface it.
      void vscode.window.showErrorMessage(
        Strings.changes.hunkSessionFailed
          .replace('{path}', relPath)
          .replace('{reason}', err instanceof Error ? err.message : String(err)),
      );
    }
  }

  clearSessions(repoKey: string, relPaths: readonly string[]): void {
    for (const relPath of relPaths) {
      this.store.closeSession(repoKey, relPath);
    }
  }

  pruneRepo(repoKey: string, liveRelPaths: ReadonlySet<string>): void {
    this.store.pruneRepo(repoKey, liveRelPaths);
  }

  /** Whether the file joins the next commit (partial session wins over the tree checkbox). */
  isJoining(repoKey: string, relPath: string): boolean {
    const session = this.store.session(repoKey, relPath);
    const effectiveCount = session ? effectiveSignatures(session).length : 0;
    return (
      entryState({ hasSession: session !== undefined, effectiveCount, treeChecked: this.treeCheckedFn?.(repoKey, relPath) ?? false }) !==
      'excluded'
    );
  }

  /** "i/n hunks" for the tree description, only while genuinely partial. */
  partialLabel(repoKey: string, relPath: string): string | undefined {
    const counts = this.store.counts(repoKey, relPath);
    if (!counts || counts.included === 0 || counts.included === counts.total) {
      return undefined;
    }
    return Strings.changes.partialFileSuffix.replace('{included}', String(counts.included)).replace('{total}', String(counts.total));
  }

  /** Effective inclusion sets for the joining-but-partial files. */
  partialPlanFor(repoKey: string, relPaths: readonly string[]): PartialPlan {
    const plan = new Map<string, Set<string>>();
    for (const relPath of relPaths) {
      const session = this.store.session(repoKey, relPath);
      if (!session) {
        continue;
      }
      const effective = effectiveSignatures(session);
      if (effective.length > 0) {
        plan.set(relPath, new Set(effective));
      }
    }
    return plan;
  }

  /** The partial-commit runner handed to the changelists service. */
  async runPartialCommit(repo: RepoHandle, members: readonly string[], partial: PartialPlan, message: string): Promise<boolean> {
    const target: PartialCommitRepo = { rootUri: repo.rootUri, cli: repo.cli };
    const result = await commitPartial(target, members, partial, message);
    if (result.stale.length > 0) {
      void vscode.window.showInformationMessage(Strings.changes.staleHunksInfo.replace('{paths}', result.stale.join(', ')));
    }
    if (result.consumedStaged.length > 0) {
      void vscode.window.showInformationMessage(
        Strings.changes.stagedConsumedInfo.replace('{paths}', result.consumedStaged.join(', ')),
      );
    }
    return result.placed.length > 0 || result.deleted.length > 0;
  }

  // ------------------------------------------------------------------ registration

  register(): vscode.Disposable {
    this.buildDecorationTypes();
    this.disposables.add(vscode.window.onDidChangeActiveColorTheme(() => this.buildDecorationTypes()));
    this.disposables.add(vscode.window.onDidChangeActiveTextEditor(() => this.applyDecorations()));
    this.disposables.add(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const uriKey = event.document.uri.toString();
        const repo = this.gitApi.getRepoForUri(event.document.uri);
        if (!repo) {
          return;
        }
        let debounced = this.docDebounces.get(uriKey);
        if (!debounced) {
          debounced = debounce(() => void this.refreshForDocument(event.document), 300);
          this.docDebounces.set(uriKey, debounced);
          this.disposables.add({ dispose: () => debounced!.cancel() });
        }
        debounced();
      }),
    );
    this.disposables.add(
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
        onDidChangeCodeLenses: this.changeEmitter.event,
        provideCodeLenses: (document, _token) => this.provideCodeLenses(document),
      }),
    );
    this.disposables.add(
      vscode.commands.registerCommand('jetgit.changes.toggleHunk', (...args: unknown[]) => this.toggleHunk(args)),
    );
    this.disposables.add({
      dispose: () => {
        this.disposeDecorationTypes();
      },
    });
    return this.disposables;
  }

  private disposeDecorationTypes(): void {
    this.includedType?.dispose();
    this.excludedType?.dispose();
  }

  private buildDecorationTypes(): void {
    this.disposeDecorationTypes();
    this.includedType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: svgUri(CHECK_SVG_DARK),
      light: { gutterIconPath: svgUri(CHECK_SVG_LIGHT) },
      gutterIconSize: 'contain',
    });
    this.excludedType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: svgUri(BOX_SVG_DARK),
      light: { gutterIconPath: svgUri(BOX_SVG_LIGHT) },
      gutterIconSize: 'contain',
    });
    this.applyDecorations();
  }

  // ------------------------------------------------------------------ lenses

  private locate(document: vscode.TextDocument): { repoKey: string; relPath: string } | undefined {
    const repo = this.gitApi.getRepoForUri(document.uri);
    if (!repo) {
      return undefined;
    }
    const repoKey = repo.rootUri.toString();
    const relPath = path.relative(repo.rootUri.fsPath, document.uri.fsPath).replace(/\\/g, '/');
    if (relPath === '' || relPath.startsWith('..')) {
      return undefined;
    }
    return this.store.session(repoKey, relPath) ? { repoKey, relPath } : undefined;
  }

  private async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const located = this.locate(document);
    if (!located) {
      return [];
    }
    const hunks = await this.hunksFor(document, located.repoKey, located.relPath);
    if (!hunks || hunks.length === 0) {
      return [];
    }
    const session = this.store.session(located.repoKey, located.relPath);
    if (!session) {
      return [];
    }
    const units = computeChangeUnits(hunks);
    const lenses: vscode.CodeLens[] = [];
    const lineCount = document.lineCount;
    units.forEach((unit, index) => {
      const sig = session.signatures[index];
      const hunk = hunks[unit.hunkIndex];
      if (!hunk) {
        return;
      }
      const range = this.unitRange(hunk, unit, lineCount);
      if (index === 0) {
        const included = effectiveSignatures(session).length;
        const counter = new vscode.CodeLens(range); // no command — renders as inert text
        counter.command = {
          command: '',
          title: Strings.changes.hunkLensCounter
            .replace('{total}', String(units.length))
            .replace('{included}', String(included)),
        };
        lenses.push(counter);
      }
      const isIncluded = sig !== undefined && session.included.has(sig);
      lenses.push(
        new vscode.CodeLens(range, {
          command: 'jetgit.changes.toggleHunk',
          title: isIncluded ? Strings.changes.hunkLensIncluded : Strings.changes.hunkLensExcluded,
          arguments: [document.uri, located.repoKey, located.relPath, index, sig],
        }),
      );
    });
    return lenses;
  }

  /** Where a unit's lens/mark lives: the changed line itself (gap line for deletions). */
  private unitRange(hunk: DiffHunk, unit: ChangeUnit, lineCount: number): vscode.Range {
    const clamp = (n: number): number => Math.min(Math.max(n, 0), Math.max(lineCount - 1, 0));
    if (unit.kind === 'del') {
      const line = clamp(hunk.newStart);
      return new vscode.Range(line, 0, line, 0);
    }
    if (unit.kind === 'block') {
      const first = hunk.newCount > 0 ? hunk.newStart - 1 : hunk.newStart;
      const start = clamp(first);
      return new vscode.Range(start, 0, clamp(start + Math.max(hunk.newCount, 1) - 1), 0);
    }
    const line = clamp(hunk.newStart - 1 + (unit.newIdxs[0] ?? 0));
    return new vscode.Range(line, 0, line, 0);
  }

  /** Signature-validated toggle from a lens click. */
  private toggleHunk(args: unknown[]): void {
    const [uriArg, repoKeyArg, relPathArg, indexArg, sigArg] = args;
    if (!(uriArg instanceof vscode.Uri) || typeof repoKeyArg !== 'string' || typeof relPathArg !== 'string' || typeof indexArg !== 'number' || typeof sigArg !== 'string') {
      return;
    }
    const session = this.store.session(repoKeyArg, relPathArg);
    if (!session || session.signatures[indexArg] !== sigArg) {
      return; // stale lens — signatures refreshed, the lenses re-render
    }
    const seedAll = this.treeCheckedFn?.(repoKeyArg, relPathArg) ?? false;
    this.store.toggle(repoKeyArg, relPathArg, indexArg, seedAll);
  }

  /** Per-document hunk computation with version caching and in-flight dedupe. */
  private async hunksFor(document: vscode.TextDocument, repoKey: string, relPath: string): Promise<DiffHunk[] | undefined> {
    const key = document.uri.toString();
    const cached = this.hunkCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.hunks;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const repo = this.gitApi.repositories.find((r) => r.rootUri.toString() === repoKey);
    if (!repo) {
      return undefined;
    }
    const promise = (async (): Promise<DiffHunk[] | undefined> => {
      const headBytes = await refContent(this.adapterFor(repo), 'HEAD', relPath);
      if (!headBytes) {
        return undefined;
      }
      const hunks = await diffWorktreeVsHead(this.adapterFor(repo), headBytes, document.getText());
      this.hunkCache.set(key, { version: document.version, hunks });
      this.store.refreshSignatures(repoKey, relPath, allUnitSignatures(computeChangeUnits(hunks), hunks));
      return hunks;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async refreshForDocument(document: vscode.TextDocument): Promise<void> {
    const located = this.locate(document);
    if (!located) {
      return;
    }
    const hunks = await this.hunksFor(document, located.repoKey, located.relPath);
    if (hunks !== undefined) {
      this.applyDecorations();
      this.changeEmitter.fire();
    }
  }

  // ------------------------------------------------------------------ decorations

  private applyDecorations(): void {
    if (!this.includedType || !this.excludedType) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      const located = this.locate(editor.document);
      if (!located) {
        editor.setDecorations(this.includedType, []);
        editor.setDecorations(this.excludedType, []);
        continue;
      }
      const cached = this.hunkCache.get(editor.document.uri.toString());
      const session = this.store.session(located.repoKey, located.relPath);
      if (!cached || !session) {
        continue;
      }
      const includedRanges: vscode.Range[] = [];
      const excludedRanges: vscode.Range[] = [];
      const lineCount = editor.document.lineCount;
      const units = computeChangeUnits(cached.hunks);
      units.forEach((unit, index) => {
        const sig = session.signatures[index];
        const hunk = cached.hunks[unit.hunkIndex];
        if (sig === undefined || !hunk) {
          return;
        }
        (session.included.has(sig) ? includedRanges : excludedRanges).push(this.unitRange(hunk, unit, lineCount));
      });
      editor.setDecorations(this.includedType, includedRanges);
      editor.setDecorations(this.excludedType, excludedRanges);
    }
  }

  private adapterFor(repo: RepoHandle): RollbackAdapter {
    return {
      cwd: () => repo.rootUri.fsPath,
      runReadOnly: async (args) => repo.cli.runReadOnly(repo.rootUri.fsPath, args),
    };
  }
}
