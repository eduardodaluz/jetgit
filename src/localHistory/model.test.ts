import { describe, it, expect } from 'vitest';
import { applyRetention, newEntryId, type LHFileRecord } from './model';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const day = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();
const sec = (n: number): string => new Date(NOW - n * 1000).toISOString();

function record(entries: LHFileRecord['entries']): LHFileRecord {
  return { path: 'C:/w/app.ts', entries };
}

const opts = { retentionDays: 5, maxPerFile: 3 };

describe('applyRetention', () => {
  it('prunes unlabeled entries older than the retention window', () => {
    const result = applyRetention(record([
      { id: 'a', ts: sec(10), bytes: 1, deleted: false },
      { id: 'old', ts: day(6), bytes: 1, deleted: false },
    ]), NOW, opts);
    expect(result.keep.map((e) => e.id)).toEqual(['a']);
    expect(result.dropIds).toEqual(['old']);
    expect(result.purgeFile).toBe(false);
  });

  it('keeps labeled entries beyond the age window', () => {
    const result = applyRetention(record([
      { id: 'lbl', ts: day(30), bytes: 1, label: 'before refactor', deleted: false },
    ]), NOW, opts);
    expect(result.keep.map((e) => e.id)).toEqual(['lbl']);
    expect(result.dropIds).toEqual([]);
  });

  it('count cap drops oldest unlabeled first, labeled survive', () => {
    const result = applyRetention(record([
      { id: 'n1', ts: sec(10), bytes: 1, deleted: false },
      { id: 'n2', ts: sec(20), bytes: 1, deleted: false },
      { id: 'n3', ts: sec(30), bytes: 1, deleted: false },
      { id: 'n4', ts: sec(40), bytes: 1, deleted: false },
      { id: 'keep-lbl', ts: sec(50), bytes: 1, label: 'checkpoint', deleted: false },
    ]), NOW, { retentionDays: 5, maxPerFile: 3 });
    expect(result.keep.some((e) => e.id === 'keep-lbl')).toBe(true);
    expect(result.keep.filter((e) => !e.label).map((e) => e.id)).toEqual(['n1', 'n2', 'n3']);
    expect(result.dropIds).toEqual(['n4']);
  });

  it('purges the whole file when history is entirely stale', () => {
    const result = applyRetention(record([
      { id: 'old1', ts: day(9), bytes: 1, deleted: false },
      { id: 'old2', ts: day(8), bytes: 1, deleted: false },
    ]), NOW, opts);
    expect(result.purgeFile).toBe(true);
  });

  it('tombstoned file is not purged while inside the retention window', () => {
    const result = applyRetention(record([
      { id: 'tomb', ts: sec(86_400), bytes: 0, deleted: true },
      { id: 'content', ts: sec(86_400 + 60), bytes: 10, deleted: false },
    ]), NOW, opts);
    expect(result.purgeFile).toBe(false);
    expect(result.keep.map((e) => e.id)).toEqual(['tomb', 'content']);
  });

  it('stale tombstoned file is purged entirely (bounded deleted-file history)', () => {
    const result = applyRetention(record([
      { id: 'tomb', ts: day(9), bytes: 0, deleted: true },
      { id: 'content', ts: day(10), bytes: 10, deleted: false },
    ]), NOW, opts);
    expect(result.purgeFile).toBe(true);
  });

  it('keeps entries newest-first after pruning', () => {
    const result = applyRetention(record([
      { id: 'a', ts: sec(1), bytes: 1, deleted: false },
      { id: 'b', ts: sec(2), bytes: 1, deleted: false },
      { id: 'old', ts: day(6), bytes: 1, deleted: false },
    ]), NOW, opts);
    expect(result.keep.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('newEntryId is sortable and unique within the same second', () => {
    const when = new Date(NOW);
    const a = newEntryId(when);
    const b = newEntryId(when);
    expect(a).toMatch(/^\d{8}T\d{6}-[0-9a-f]{4}$/);
    expect(a.slice(0, 15)).toBe(b.slice(0, 15));
    expect(a).not.toBe(b);
    expect(newEntryId(new Date(NOW - 5000)) < a).toBe(true);
  });
});
