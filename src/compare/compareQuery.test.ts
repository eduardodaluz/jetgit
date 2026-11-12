import { describe, expect, it } from 'vitest';
import type { BlameAdapter } from '../blame/blameQuery';
import { compareCounts, compareFiles, groupRefs, listCommits, parseLeftRightCount } from './compareQuery';
import { LOG_FORMAT } from '../git/logParser';

describe('parseLeftRightCount', () => {
  it('parses the --left-right --count pair (tab or spaces)', () => {
    expect(parseLeftRightCount('1\t2')).toEqual({ outgoing: 1, incoming: 2 });
    expect(parseLeftRightCount('0\t0')).toEqual({ outgoing: 0, incoming: 0 });
    expect(parseLeftRightCount(' 12  7\n')).toEqual({ outgoing: 12, incoming: 7 });
  });

  it('rejects output that is not a count pair', () => {
    expect(() => parseLeftRightCount('only one number')).toThrow();
    expect(() => parseLeftRightCount('1\tbanana')).toThrow();
    expect(() => parseLeftRightCount('')).toThrow();
  });
});

describe('groupRefs', () => {
  const REF = { HEAD: 1, REMOTE_HEAD: 2, TAG: 3 };

  it('groups by type, sorts alphabetically, excludes HEAD pseudo-refs', () => {
    const groups = groupRefs([
      { type: REF.HEAD, name: 'feature/zeta' },
      { type: REF.HEAD, name: 'main' },
      { type: REF.HEAD, name: 'HEAD' },
      { type: REF.HEAD }, // detached, nameless
      { type: REF.REMOTE_HEAD, name: 'main', remote: 'origin' },
      { type: REF.TAG, name: 'v1.0' },
      { type: 99, name: 'mystery' }, // unknown type → ignored
    ]);
    expect(groups.branches).toEqual(['feature/zeta', 'main']);
    expect(groups.remotes).toEqual(['origin/main']);
    expect(groups.tags).toEqual(['v1.0']);
  });

  it('normalizes remote refs whether the API reports full or short names', () => {
    const full = groupRefs([{ type: REF.REMOTE_HEAD, name: 'origin/main' }]);
    const short = groupRefs([{ type: REF.REMOTE_HEAD, name: 'main', remote: 'origin' }]);
    expect(full.remotes).toEqual(['origin/main']);
    expect(short.remotes).toEqual(['origin/main']);
    // A remote named exactly like the name prefix is not double-prefixed.
    const alreadyFull = groupRefs([{ type: REF.REMOTE_HEAD, name: 'origin/main', remote: 'origin' }]);
    expect(alreadyFull.remotes).toEqual(['origin/main']);
  });
});

/** Fake adapter serving canned git output and recording argv. */
function fakeAdapter(responses: Record<string, Buffer>): BlameAdapter & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    cwd: () => '/unused',
    runReadOnly: async (args) => {
      calls.push(args);
      const key = args.join(' ');
      const out = responses[key];
      if (out === undefined) {
        return { stdout: Buffer.alloc(0), stderr: `no canned response for: ${key}`, code: 1 };
      }
      return { stdout: out, stderr: '', code: 0 };
    },
  };
}

describe('compareFiles', () => {
  it('maps the committed matrix onto IntelliJ classes (A→local, D→ref, M/R→diff)', async () => {
    const out = Buffer.from('A\0new.txt\0D\0gone.txt\0M\0mod.txt\0R100\0old.txt\0renamed.txt\0\0');
    const adapter = fakeAdapter({ 'diff --name-status -z -M feature HEAD': out });
    const files = await compareFiles(adapter, 'feature', 'committed');
    expect(files.map((f) => `${f.status}:${f.path}=${f.cls}`)).toEqual([
      'A:new.txt=local',
      'D:gone.txt=ref',
      'M:mod.txt=diff',
      'R:renamed.txt=diff',
    ]);
    expect(files.find((f) => f.path === 'renamed.txt')?.oldPath).toBe('old.txt');
    expect(adapter.calls[0]).toEqual(['diff', '--name-status', '-z', '-M', 'feature', 'HEAD']);
  });

  it('worktree mode diffs against the working tree (no HEAD in argv)', async () => {
    const adapter = fakeAdapter({ 'diff --name-status -z -M feature': Buffer.from('M\0dirty.txt\0\0') });
    const files = await compareFiles(adapter, 'feature', 'worktree');
    expect(files).toEqual([{ path: 'dirty.txt', status: 'M', cls: 'diff' }]);
    expect(adapter.calls[0]).toEqual(['diff', '--name-status', '-z', '-M', 'feature']);
  });

  it('propagates git failures (the service decides how to surface them)', async () => {
    const adapter = fakeAdapter({});
    await expect(compareFiles(adapter, 'no-such-ref', 'committed')).rejects.toThrow(/failed/);
  });
});

describe('compareCounts + listCommits', () => {
  it('reads exact counts from the symmetry range with HEAD on the left (rev-list)', async () => {
    const adapter = fakeAdapter({ 'rev-list --left-right --count HEAD...feature': Buffer.from('3\t9\n') });
    const counts = await compareCounts(adapter, 'feature');
    expect(counts).toEqual({ outgoing: 3, incoming: 9 });
    expect(adapter.calls[0]).toEqual(['rev-list', '--left-right', '--count', 'HEAD...feature']);
  });

  it('lists commits for a range with the max-count cap in argv', async () => {
    // Real git output shape: %x1e-wrapped records, %x1f-separated fields
    // ('' H h an ae at s b P).
    const log = Buffer.from('\u001e\u001fabc\u001fabc\u001fAda\u001fa@t\u001f1700000000\u001fsubject one\u001f\u001fdef\u001e');
    const adapter = fakeAdapter({ [`log --max-count=200 --format=${LOG_FORMAT} HEAD..feature`]: log });
    const commits = await listCommits(adapter, 'HEAD..feature', 200);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe('subject one');
    expect(commits[0]?.authorEmail).toBe('a@t');
    expect(adapter.calls[0]).toEqual(['log', '--max-count=200', `--format=${LOG_FORMAT}`, 'HEAD..feature']);
  });
});
