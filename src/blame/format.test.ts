import { describe, expect, it } from 'vitest';
import { UNCOMMITTED_SHA } from '../git/blameParser';
import type { BlameCommit } from '../git/blameParser';
import { buildHoverMarkdown, commandLinkArgs, escapeMarkdown, formatDateLong, formatDateShort, renderAnnotation, renderFormat } from './format';

const COMMIT: BlameCommit = {
  sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  author: 'Alice Dev',
  email: 'alice@team.io',
  timeSeconds: 1762166400, // 2025-11-03T12:00:00Z
  summary: 'Fix the [tricky] bug',
  boundary: false,
};

const TARGETS = {
  openCommit: (sha: string) => `command:jetgit.blame.openCommit?${commandLinkArgs([sha, 'file:///w/a.txt'])}`,
  copySha: (sha: string) => `command:jetgit.blame.copySha?${commandLinkArgs([sha])}`,
};

describe('renderFormat', () => {
  it('substitutes every supported token', () => {
    const out = renderFormat('{author} · {date} · {sha} · {email} · {summary}', {
      author: 'Alice',
      email: 'a@x',
      sha: 'abc12345',
      summary: 'Subject here',
      date: '2025-11-03',
    });
    expect(out).toBe('Alice · 2025-11-03 · abc12345 · a@x · Subject here');
  });

  it('leaves unknown tokens literal (no silent mangling of custom templates)', () => {
    const out = renderFormat('{author} wrote this on {day}', {
      author: 'Alice',
      email: 'a@x',
      sha: 'abc12345',
      summary: 's',
      date: '2025-11-03',
    });
    expect(out).toBe('Alice wrote this on {day}');
  });
});

describe('renderAnnotation', () => {
  it('renders the default template with short date + short sha', () => {
    const text = renderAnnotation('{author} · {date}', COMMIT);
    expect(text).toMatch(/^Alice Dev · \d{4}-\d{2}-\d{2}$/);
    expect(renderAnnotation('{sha}', COMMIT)).toBe(COMMIT.sha.slice(0, 8));
  });
});

describe('date formatting', () => {
  it('short date matches YYYY-MM-DD regardless of local timezone', () => {
    expect(formatDateShort(COMMIT.timeSeconds)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('long date adds HH:MM', () => {
    expect(formatDateLong(COMMIT.timeSeconds)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('degrades to empty string on invalid timestamps', () => {
    expect(formatDateShort(Number.NaN)).toBe('');
    expect(formatDateLong(-99999999999999)).toBe('');
  });
});

describe('buildHoverMarkdown', () => {
  it('includes subject, short sha, author, date and trusted command links', () => {
    const md = buildHoverMarkdown(COMMIT, TARGETS, 'Body line one\n\nBody line two');
    expect(md).toContain('**Fix the \\[tricky\\] bug**');
    expect(md).toContain(COMMIT.sha.slice(0, 8));
    expect(md).toContain('Alice Dev');
    expect(md).toContain('Body line one');
    expect(md).toContain(`command:jetgit.blame.openCommit?${commandLinkArgs([COMMIT.sha, 'file:///w/a.txt'])}`);
    expect(md).toContain(`command:jetgit.blame.copySha?${commandLinkArgs([COMMIT.sha])}`);
  });

  it('omits the body section when no body is given', () => {
    const md = buildHoverMarkdown(COMMIT, TARGETS);
    expect(md).not.toContain('---');
  });

  it('uncommitted lines get a plain explanation and no command links', () => {
    const md = buildHoverMarkdown({ ...COMMIT, sha: UNCOMMITTED_SHA, author: 'Not Committed Yet' }, TARGETS);
    expect(md).toContain('not committed');
    expect(md).not.toContain('command:');
  });
});

describe('escapeMarkdown', () => {
  it('escapes markdown-sensitive characters in user text (links/code/emphasis)', () => {
    expect(escapeMarkdown('a [b] `c` *d* _e_ ~f~ #g')).toBe('a \\[b\\] \\`c\\` \\*d\\* \\_e\\_ \\~f\\~ \\#g');
  });
});
