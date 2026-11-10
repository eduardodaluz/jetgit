import { describe, it, expect } from 'vitest';
import { LOG_FORMAT, parseGitLog } from './logParser';

const RS = '\u001e';
const US = '\u001f';

describe('parseGitLog', () => {
  it('parses a simple commit record', () => {
    const raw = `${RS}${US}abc123def456${US}abc123d${US}Ada Lovelace${US}ada@example.com${US}1700000000${US}Initial commit${US}${US} ${US}`;
    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({
      hash: 'abc123def456',
      shortHash: 'abc123d',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authorDateSeconds: 1700000000,
      subject: 'Initial commit',
      body: '',
      parentHashes: [],
    });
  });

  it('parses merge parents and multi-line bodies with unicode', () => {
    const raw = [
      RS,
      US,
      'def4567890',
      US,
      'def4567',
      US,
      'Zoë Möller',
      US,
      'zoe@example.com',
      US,
      '1700000100',
      US,
      'Merge branch feature ✨',
      US,
      'Body line 1\n\nBody line 2 — ünïcode',
      US,
      'aaa1111bbb bbb2222ccc',
      US,
    ].join('');
    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.parentHashes).toEqual(['aaa1111bbb', 'bbb2222ccc']);
    expect(commits[0]?.body).toContain('ünïcode');
    expect(commits[0]?.authorName).toBe('Zoë Möller');
  });

  it('returns multiple records in order and skips empty segments', () => {
    const record = (h: string, subject: string): string => `${RS}${US}${h}${US}${h.slice(0, 7)}${US}a${US}a@x${US}1${US}${subject}${US}${US}${US}`;
    const raw = `${record('1111111111', 'one')}${record('2222222222', 'two')}junk${RS}junk`;
    const commits = parseGitLog(raw);
    expect(commits.map((c) => c.subject)).toEqual(['one', 'two']);
  });

  it('LOG_FORMAT uses only %x-escaped control characters', () => {
    expect(LOG_FORMAT).toContain('%x1e');
    expect(LOG_FORMAT).toContain('%x1f');
    expect(LOG_FORMAT).not.toContain('\u001e');
  });
});
