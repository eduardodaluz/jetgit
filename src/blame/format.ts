/**
 * Blame annotation formatting — pure string functions, no vscode imports.
 * The controller wraps the hover markdown into a vscode.MarkdownString.
 */
import { UNCOMMITTED_SHA } from '../git/blameParser';
import type { BlameCommit } from '../git/blameParser';

export interface FormatTokens {
  author: string;
  email: string;
  sha: string;
  summary: string;
  /** Formatted date, already rendered by the caller (short or long). */
  date: string;
}

/** Substitutes {author} {email} {date} {sha} {summary}; unknown tokens stay literal. */
export function renderFormat(template: string, tokens: FormatTokens): string {
  return template.replace(/\{(author|email|date|sha|summary)\}/g, (_all, key: keyof FormatTokens) => tokens[key] ?? '');
}

/** Short annotation date, deterministic across machines: YYYY-MM-DD. */
export function formatDateShort(timeSeconds: number): string {
  const d = new Date(timeSeconds * 1000);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Long hover date: YYYY-MM-DD HH:MM (local time). */
export function formatDateLong(timeSeconds: number): string {
  const d = new Date(timeSeconds * 1000);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${formatDateShort(timeSeconds)} ${hh}:${min}`;
}

/** Renders the inline annotation text from the format template. */
export function renderAnnotation(template: string, commit: BlameCommit): string {
  return renderFormat(template, {
    author: commit.author,
    email: commit.email,
    sha: commit.sha.slice(0, 8),
    summary: commit.summary,
    date: formatDateShort(commit.timeSeconds),
  });
}

export interface HoverCommandTargets {
  /** command:jetgit.blame.openCommit — receives [sha, fileUri] */
  openCommit: (sha: string) => string;
  /** command:jetgit.blame.copySha — receives [sha] */
  copySha: (sha: string) => string;
}

/** Builds hover markdown for a blame commit (returns text; caller wraps in MarkdownString). */
export function buildHoverMarkdown(commit: BlameCommit, targets: HoverCommandTargets, body?: string): string {
  const out: string[] = [];
  if (commit.sha === UNCOMMITTED_SHA) {
    out.push(`**${commit.author || 'Uncommitted changes'}**`);
    out.push('');
    out.push('These lines are modified in the working tree and not committed yet.');
    return out.join('\n');
  }
  out.push(`**${escapeMarkdown(commit.summary)}**`);
  out.push('');
  const shortSha = `\`${commit.sha.slice(0, 8)}\``;
  out.push(`${shortSha} — ${escapeMarkdown(commit.author)} <${commit.email}>`);
  out.push('');
  out.push(formatDateLong(commit.timeSeconds));
  const trimmedBody = body?.trim();
  if (trimmedBody) {
    out.push('');
    out.push('---');
    out.push(escapeMarkdown(trimmedBody));
  }
  out.push('');
  out.push(`[${'Open Commit'}](${targets.openCommit(commit.sha)} "Open Commit") · [${'Copy Commit SHA'}](${targets.copySha(commit.sha)} "Copy Commit SHA")`);
  return out.join('\n');
}

/** Escapes markdown-sensitive characters in user-authored text. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[[\]()`_*\\~#]/g, (ch) => `\\${ch}`);
}

/** URI-encodes command arguments for a trusted command: markdown link. */
export function commandLinkArgs(args: readonly unknown[]): string {
  return encodeURIComponent(JSON.stringify(args));
}
