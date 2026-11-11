/**
 * Inline blame controller: renders blame annotations as editor decorations.
 *
 * Modes (jetgit.blame.mode):
 *  - off          — no decorations
 *  - currentLine  — highlight + annotation on the cursor line (default)
 *  - wholeFile    — highlight + annotation per line (opt-in; one git call)
 *
 * Hard rules:
 *  - Generation discipline: every update() invalidates previous generations,
 *    captures its own, and only a still-current result may paint — a stale
 *    blame result can never overwrite a newer one.
 *  - Annotation contentText is fixed per decoration type, so whole-file
 *    annotations are GROUPED BY COMMIT (one type per distinct commit sha);
 *    line highlights are grouped by author bucket (8 fixed types).
 *  - High-contrast themes get no line backgrounds (accessibility).
 *  - The built-in Git blame decoration is never touched — a one-time hint
 *    points at its setting instead.
 */
import * as vscode from 'vscode';
import { debounce, DisposableCollection, GenerationToken } from '../common/async';
import { debug } from '../common/log';
import { settings } from '../common/settingsInstance';
import { Strings } from '../strings';
import { GitApiService, type RepoHandle } from '../git/gitApi';
import { UNCOMMITTED_SHA, type BlameCommit } from '../git/blameParser';
import { ANNOTATION_COLOR_TOKEN, BUCKET_COUNT, bucketFor, paletteFor, type ThemeKind } from './palette';
import { buildHoverMarkdown, commandLinkArgs, renderAnnotation } from './format';
import { registerBlameCommands } from './commands';
import { BlameService } from './service';

const SELECTION_DEBOUNCE_MS = 250;
/** Whole-file safety cap: beyond this many distinct commits, skip after-text (highlights+hover remain). */
const MAX_ANNOTATION_GROUPS = 250;
const BUILTIN_HINT_SHOWN_KEY = 'jetgit.blame.builtinHintShown';

export class BlameController {
  private readonly disposables = new DisposableCollection();
  private readonly service: BlameService;
  private readonly token = new GenerationToken();
  private readonly updateSelection: (() => void) & { cancel(): void };

  /** Fixed per-bucket highlight types (recreated per theme). */
  private highlightTypes: vscode.TextEditorDecorationType[] = [];
  /** Per-render annotation types (committed contentText) — disposed on re-render. */
  private annotationTypes: vscode.TextEditorDecorationType[] = [];

  constructor(
    private readonly gitApi: GitApiService,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.service = new BlameService(gitApi);
    this.buildDecorationTypes();
    this.disposables.add({ dispose: () => this.disposeTypes() });
    this.disposables.add({ dispose: () => this.disposeHighlightTypes() });

    this.updateSelection = debounce(() => this.update(), SELECTION_DEBOUNCE_MS);
    this.disposables.add({ dispose: () => this.updateSelection.cancel() });

    this.disposables.add(vscode.window.onDidChangeActiveTextEditor(() => this.update()));
    this.disposables.add(vscode.window.onDidChangeTextEditorSelection(() => this.updateSelection()));
    this.disposables.add(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        // A save may change blame (working-tree lines become committed) and
        // always changes mtime — the file cache keys on it.
        if (doc.uri.scheme === 'file' && vscode.window.activeTextEditor?.document.uri.toString() === doc.uri.toString()) {
          this.update();
        }
      }),
    );
    this.disposables.add(
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.buildDecorationTypes();
        this.update();
      }),
    );
    this.disposables.add(
      settings().onDidChange(() => {
        this.buildDecorationTypes();
        this.update();
      }),
    );
    this.disposables.add(this.watchRepos());

    void this.update();
  }

  /** Re-subscribes per-repo state events whenever the repo set changes — HEAD moves re-blame. */
  private watchRepos(): vscode.Disposable {
    const repoSubs = new DisposableCollection();
    const wire = (): void => {
      void repoSubs.dispose();
      for (const repo of this.gitApi.repositories) {
        repoSubs.add(repo.onDidChangeState(() => this.update()));
      }
    };
    wire();
    this.disposables.add(this.gitApi.onDidChangeRepos(wire));
    return { dispose: () => void repoSubs.dispose() };
  }

  /** Registers jetgit.blame.* commands (setMode / openCommit / copySha). */
  registerCommands(): vscode.Disposable {
    return registerBlameCommands(this.gitApi, this.service);
  }

  // ---------------------------------------------------------------- rendering

  private buildDecorationTypes(): void {
    const palette = paletteFor(this.themeKind());
    this.disposeTypes();
    this.disposeHighlightTypes();
    this.highlightTypes = [];
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
      const color = palette[bucket];
      this.highlightTypes.push(
        vscode.window.createTextEditorDecorationType(color ? { isWholeLine: true, backgroundColor: color } : {}),
      );
    }
  }

  private themeKind(): ThemeKind {
    const kind = vscode.window.activeColorTheme.kind;
    if (kind === vscode.ColorThemeKind.Dark) {
      return 'dark';
    }
    if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) {
      return 'high-contrast';
    }
    return 'light';
  }

  private disposeTypes(): void {
    for (const type of this.annotationTypes) {
      type.dispose();
    }
    this.annotationTypes = [];
  }

  private disposeHighlightTypes(): void {
    for (const type of this.highlightTypes) {
      type.dispose();
    }
  }

  private clearAll(editor: vscode.TextEditor): void {
    for (const type of this.highlightTypes) {
      editor.setDecorations(type, []);
    }
    for (const type of this.annotationTypes) {
      editor.setDecorations(type, []);
    }
    this.disposeTypes();
  }

  /** Single entry point: renders blame for the active editor, or clears. */
  private async update(): Promise<void> {
    this.token.invalidate(); // everything older is stale
    const captured = this.token.capture();

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const mode = settings().value.blame.mode;
    const repo = this.gitApi.getRepoForUri(editor.document.uri);
    if (mode === 'off' || !this.gitApi.available || !repo) {
      this.clearAll(editor);
      return;
    }
    try {
      if (mode === 'wholeFile') {
        await this.renderWholeFile(editor, repo, captured);
      } else {
        await this.renderCurrentLine(editor, repo, captured);
      }
    } catch (err) {
      debug(`blame render failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async renderCurrentLine(editor: vscode.TextEditor, repo: RepoHandle, captured: number): Promise<void> {
    const doc = editor.document;
    const line = editor.selection.active.line;
    if (line >= doc.lineCount) {
      return;
    }
    const result = await this.service.blameLine(doc.uri, doc.version, line + 1);
    if (!this.token.isCurrent(captured)) {
      return;
    }
    this.clearAll(editor);
    const sha = result?.lineToSha.get(line + 1);
    const commit = sha !== undefined ? result?.commits.get(sha) : undefined;
    if (!commit || sha === undefined) {
      return;
    }
    // Current-line hover includes the commit body (one extra cheap git call,
    // still well inside the annotation budget).
    const body = await this.service.commitBody(repo, sha);
    if (!this.token.isCurrent(captured)) {
      return;
    }

    const wholeLine = new vscode.Range(line, 0, line, 0);
    const endOfLine = doc.lineAt(line).range.end;
    const colorEnabled = settings().value.blame.coloring;
    const palette = paletteFor(this.themeKind());
    const bucket = bucketFor(commit.email);
    if (colorEnabled && commit.sha !== UNCOMMITTED_SHA && palette[bucket] !== undefined) {
      editor.setDecorations(this.highlightTypes[bucket] as vscode.TextEditorDecorationType, [wholeLine]);
    }

    const type = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: ` ${renderAnnotation(settings().value.blame.format, commit)}`,
        color: new vscode.ThemeColor(ANNOTATION_COLOR_TOKEN),
        margin: '0 0 0 1ch',
      },
    });
    this.annotationTypes.push(type);
    editor.setDecorations(type, [{ range: new vscode.Range(endOfLine, endOfLine), hoverMessage: this.hoverMarkdown(commit, doc.uri, body ?? undefined) }]);
  }

  private async renderWholeFile(editor: vscode.TextEditor, repo: RepoHandle, captured: number): Promise<void> {
    const doc = editor.document;
    const result = await this.service.blameFile(doc.uri);
    if (!this.token.isCurrent(captured)) {
      return;
    }
    this.clearAll(editor);
    this.maybeShowBuiltInHint();
    if (!result) {
      return;
    }

    const colorEnabled = settings().value.blame.coloring;
    const palette = paletteFor(this.themeKind());
    const format = settings().value.blame.format;

    // Group ranges: highlights by bucket, annotations by commit (contentText
    // is fixed per decoration type).
    const bucketRanges = new Map<number, vscode.Range[]>();
    const commitLines = new Map<string, { commit: BlameCommit; lines: number[] }>();
    for (let line = 1; line <= doc.lineCount; line++) {
      const sha = result.lineToSha.get(line);
      const commit = sha !== undefined ? result.commits.get(sha) : undefined;
      if (sha === undefined || !commit) {
        continue;
      }
      if (colorEnabled && sha !== UNCOMMITTED_SHA) {
        const bucket = bucketFor(commit.email);
        if (palette[bucket] !== undefined) {
          const ranges = bucketRanges.get(bucket) ?? [];
          ranges.push(new vscode.Range(line - 1, 0, line - 1, 0));
          bucketRanges.set(bucket, ranges);
        }
      }
      const entry = commitLines.get(sha);
      if (entry) {
        entry.lines.push(line);
      } else {
        commitLines.set(sha, { commit, lines: [line] });
      }
    }
    for (const [bucket, ranges] of bucketRanges) {
      editor.setDecorations(this.highlightTypes[bucket] as vscode.TextEditorDecorationType, ranges);
    }

    if (commitLines.size > MAX_ANNOTATION_GROUPS) {
      debug(`blame annotations skipped (${commitLines.size} distinct commits > ${MAX_ANNOTATION_GROUPS})`);
      return;
    }
    for (const entry of commitLines.values()) {
      const type = vscode.window.createTextEditorDecorationType({
        after: {
          contentText: ` ${renderAnnotation(format, entry.commit)}`,
          color: new vscode.ThemeColor(ANNOTATION_COLOR_TOKEN),
          margin: '0 0 0 1ch',
        },
      });
      this.annotationTypes.push(type);
      const ranges = entry.lines
        .filter((n) => n <= doc.lineCount)
        .map((n) => doc.lineAt(n - 1).range.end)
        .map((end) => new vscode.Range(end, end));
      if (ranges.length === 0) {
        continue;
      }
      editor.setDecorations(type, [
        { range: ranges[0] as vscode.Range, hoverMessage: this.hoverMarkdown(entry.commit, doc.uri) },
        ...ranges.slice(1).map((r) => ({ range: r })),
      ]);
    }
  }

  /** Trusted hover markdown with command links (Open Commit / Copy SHA). */
  private hoverMarkdown(commit: BlameCommit, fileUri: vscode.Uri, body?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString(
      buildHoverMarkdown(
        commit,
        {
          openCommit: (sha) => `command:jetgit.blame.openCommit?${commandLinkArgs([sha, fileUri.toString()])}`,
          copySha: (sha) => `command:jetgit.blame.copySha?${commandLinkArgs([sha])}`,
        },
        body,
      ),
    );
    md.isTrusted = true;
    return md;
  }

  /** One-time hint: JetGit whole-file blame can overlap the built-in decoration. */
  private maybeShowBuiltInHint(): void {
    if (this.context.globalState.get(BUILTIN_HINT_SHOWN_KEY) === true) {
      return;
    }
    const builtinEnabled = vscode.workspace.getConfiguration('git.blame').get<boolean>('editorDecoration.enabled', true);
    if (!builtinEnabled) {
      return;
    }
    void this.context.globalState.update(BUILTIN_HINT_SHOWN_KEY, true);
    void vscode.window
      .showInformationMessage(Strings.blame.builtinHint, Strings.blame.builtinHintOpenSettings)
      .then((choice) => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'git.blame.editorDecoration.enabled');
        }
      }, () => undefined);
  }

  dispose(): void {
    this.disposables.dispose();
    this.disposeTypes();
    this.disposeHighlightTypes();
    this.highlightTypes = [];
    this.service.dispose();
  }
}
