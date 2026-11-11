import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalHistoryStore, dataKeyFor } from './store';
import { applyRetention } from './model';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-lh-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function newStore(name: string): LocalHistoryStore {
  return new LocalHistoryStore(path.join(tmpDir, name));
}

describe('LocalHistoryStore', () => {
  it('snapshots gzip-compact and restore byte-identical', async () => {
    const store = newStore('roundtrip');
    const file = path.join(tmpDir, 'roundtrip-src.ts');
    const v1 = Buffer.from('export const version = 1;\n'.repeat(500), 'utf8');
    const v2 = Buffer.from('export const version = 2;\n'.repeat(500), 'utf8');
    fs.writeFileSync(file, v1);
    await store.recordSnapshot(file, v1);
    fs.writeFileSync(file, v2);
    await store.recordSnapshot(file, v2);

    const key = dataKeyFor(file);
    const index = await store.get();
    const entries = index.files[key]?.entries ?? [];
    expect(entries).toHaveLength(2);
    const firstTs = entries[0]?.ts ?? '';
    const secondTs = entries[1]?.ts ?? '';
    expect(firstTs >= secondTs).toBe(true);

    const restoredOld = await store.readSnapshot(key, entries[1]!.id);
    const restoredNew = await store.readSnapshot(key, entries[0]!.id);
    expect(restoredOld?.equals(v1)).toBe(true);
    expect(restoredNew?.equals(v2)).toBe(true);

    // gzip actually compacts the repetitive source text
    const gzSize = fs.statSync(path.join(store.dataPath(key, entries[0]!.id))).size;
    expect(gzSize).toBeLessThan(v2.length);
  });

  it('dedupes identical consecutive content at the engine level via sha256', async () => {
    const store = newStore('dedupe');
    const file = path.join(tmpDir, 'same.ts');
    const content = Buffer.from('unchanged content\n');
    await store.recordSnapshot(file, content);
    const key = dataKeyFor(file);
    const first = (await store.get()).files[key]?.entries[0];
    // Engine compares this sha against a fresh read before snapshotting.
    expect(first?.sha256).toBeDefined();
  });

  it('tombstones a deleted file and exposes it for restore', async () => {
    const store = newStore('tombstone');
    const file = path.join(tmpDir, 'gone.ts');
    const content = Buffer.from('precious content\n');
    fs.writeFileSync(file, content);
    await store.recordSnapshot(file, content);
    await store.recordTombstone(file);

    const tombstones = await store.tombstonedPaths();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.path).toBe(file);

    const key = tombstones[0]!.key;
    const record = (await store.get()).files[key];
    const lastContent = record?.entries.find((e) => !e.deleted);
    const restored = await store.readSnapshot(key, lastContent!.id);
    expect(restored?.equals(content)).toBe(true);
  });

  it('retention: dropEntries removes gz files, purgeFile removes the directory', async () => {
    const store = newStore('retention');
    const file = path.join(tmpDir, 'many.ts');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const entry = await store.recordSnapshot(file, Buffer.from(`v${i}\n`));
      ids.push(entry.id);
    }
    const key = dataKeyFor(file);
    // Keep newest 3 — the retention rule for unlabeled-only history.
    const drop = ids.slice(0, 2); // oldest (recorded first → later in newest-first list)
    const record = (await store.get()).files[key];
    const newestFirst = record?.entries.map((e) => e.id) ?? [];
    const dropIds = newestFirst.slice(3);
    void drop;
    await store.dropEntries(key, dropIds);
    const after = (await store.get()).files[key];
    expect(after?.entries).toHaveLength(3);
    for (const id of dropIds) {
      expect(fs.existsSync(store.dataPath(key, id))).toBe(false);
    }

    await store.recordTombstone(file);
    const result = applyRetention((await store.get()).files[key]!, Date.now() + 6 * 86_400_000, {
      retentionDays: 5,
      maxPerFile: 3,
    });
    expect(result.purgeFile).toBe(true);
    await store.purgeFile(key);
    expect((await store.get()).files[key]).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, 'retention', 'data', key))).toBe(false);
  });

  it('clearAll wipes data and index', async () => {
    const store = newStore('clear');
    const file = path.join(tmpDir, 'wipe.ts');
    await store.recordSnapshot(file, Buffer.from('x\n'));
    await store.clearAll();
    const index = await store.get();
    expect(Object.keys(index.files)).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, 'clear', 'data'))).toBe(false);
  });

  it('storageUsage reports files, snapshots and disk bytes', async () => {
    const store = newStore('usage');
    const file = path.join(tmpDir, 'used.ts');
    await store.recordSnapshot(file, Buffer.from('a\n'.repeat(200)));
    const usage = await store.storageUsage();
    expect(usage.files).toBe(1);
    expect(usage.snapshots).toBe(1);
    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(usage.top[0]?.path).toBe(file);
  });
});
