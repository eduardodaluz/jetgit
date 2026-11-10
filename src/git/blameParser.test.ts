import { describe, it, expect } from 'vitest';
import { parseGitBlame, UNCOMMITTED_SHA } from './blameParser';

function header(sha: string, opts: { author?: string; email?: string; time?: string; summary?: string; previous?: string; boundary?: boolean } = {}): string {
  const lines = [
    `${sha} 1 1 1`,
    `author ${opts.author ?? 'Ada Lovelace'}`,
    `author-mail <${opts.email ?? 'ada@example.com'}>`,
    `author-time ${opts.time ?? '1700000000'}`,
    'author-tz +0000',
    `committer ${opts.author ?? 'Ada Lovelace'}`,
    `committer-mail <${opts.email ?? 'ada@example.com'}>`,
    `committer-time ${opts.time ?? '1700000000'}`,
    'committer-tz +0000',
    `summary ${opts.summary ?? 'Initial commit'}`,
  ];
  if (opts.previous) {
    lines.push(`previous ${opts.previous} src/main.ts`);
  }
  if (opts.boundary) {
    lines.push('boundary');
  }
  lines.push('filename src/main.ts');
  return lines.join('\n');
}

describe('parseGitBlame', () => {
  it('parses a single full header block', () => {
    const out = `${header('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')}\n\tline one\n`;
    const result = parseGitBlame(out);
    expect(result.lineToSha.get(1)).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const commit = result.commits.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(commit).toEqual({
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      author: 'Ada Lovelace',
      email: 'ada@example.com',
      timeSeconds: 1700000000,
      summary: 'Initial commit',
      previousSha: undefined,
      boundary: false,
    });
  });

  it('maps multiple lines to bare sha references without duplicating commits', () => {
    const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const out = [
      header(sha, { summary: 'Add feature' }),
      '\tline one',
      `${sha} 2 2 1`,
      '\tline two',
      `${sha} 3 3 1`,
      '\tline three',
    ].join('\n');
    const result = parseGitBlame(out);
    expect(result.commits.size).toBe(1);
    expect(result.lineToSha.get(1)).toBe(sha);
    expect(result.lineToSha.get(2)).toBe(sha);
    expect(result.lineToSha.get(3)).toBe(sha);
    expect(result.commits.get(sha)?.summary).toBe('Add feature');
  });

  it('captures previous sha and boundary flag', () => {
    const sha = 'cccccccccccccccccccccccccccccccccccccccc';
    const out = `${header(sha, { previous: 'dddddddddddddddddddddddddddddddddddddddd', boundary: true })}\n\tline\n`;
    const result = parseGitBlame(out);
    const commit = result.commits.get(sha);
    expect(commit?.previousSha).toBe('dddddddddddddddddddddddddddddddddddddddd');
    expect(commit?.boundary).toBe(true);
  });

  it('handles author names with spaces and uncommitted zero sha', () => {
    const out = [
      header(UNCOMMITTED_SHA, { author: 'Not Committed Yet', email: 'not.committed.yet', summary: 'Version 2 (uncommitted)' }),
      '\tworking line',
    ].join('\n');
    const result = parseGitBlame(out);
    const commit = result.commits.get(UNCOMMITTED_SHA);
    expect(commit?.author).toBe('Not Committed Yet');
    expect(result.lineToSha.get(1)).toBe(UNCOMMITTED_SHA);
  });

  it('handles CRLF line endings', () => {
    const sha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const out = `${header(sha)}\r\n\tline one\r\n`;
    const result = parseGitBlame(out);
    expect(result.lineToSha.get(1)).toBe(sha);
    expect(result.commits.get(sha)?.author).toBe('Ada Lovelace');
  });
});
