/**
 * M4 integration: Local History store round-trips inside the extension host
 * environment (real fs, real gzip) — snapshot/restore byte-identity,
 * tombstone + deleted-file recreation, retention purge. The watcher engine
 * itself is exercised by dogfooding; its invariants (never block a save)
 * are structural: all hooks are fire-and-forget with swallowed errors.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalHistoryStore, dataKeyFor } from '../../localHistory/store';
import { applyRetention } from '../../localHistory/model';

const fixturesDir = process.env.JETGIT_FIXTURES_DIR ?? os.tmpdir();

suite('local history round-trips (M4)', () => {
  let root: string;
  let store: LocalHistoryStore;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-lh-int-'));
    store = new LocalHistoryStore(root);
  });

  teardown(async () => {
    await store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('edit → snapshot → modify → restore earlier state byte-identical', async () => {
    const file = path.join(root, 'app.ts');
    const v1 = Buffer.from('const a = 1;\n', 'utf8');
    const v2 = Buffer.from('const a = 2;\nconst b = 3;\n', 'utf8');
    fs.writeFileSync(file, v1);
    await store.recordSnapshot(file, v1);
    fs.writeFileSync(file, v2);
    await store.recordSnapshot(file, v2);

    const key = dataKeyFor(file);
    const entries = (await store.get()).files[key]?.entries ?? [];
    assert.equal(entries.length, 2, 'two snapshots recorded');

    const restored = await store.readSnapshot(key, entries[1]!.id);
    assert.ok(restored?.equals(v1), 'earlier state restores byte-identical');
  });

  test('deleted file → tombstone → recreate byte-identical', async () => {
    const file = path.join(root, 'precious.ts');
    const content = Buffer.from('cannot lose this\n'.repeat(20), 'utf8');
    fs.writeFileSync(file, content);
    await store.recordSnapshot(file, content);
    fs.rmSync(file);
    await store.recordTombstone(file);

    const tombstones = await store.tombstonedPaths();
    assert.equal(tombstones.length, 1);
    const record = (await store.get()).files[tombstones[0]!.key];
    const lastContent = record?.entries.find((e) => !e.deleted);
    assert.ok(lastContent, 'a content snapshot survives the tombstone');
    const restored = await store.readSnapshot(tombstones[0]!.key, lastContent!.id);
    assert.ok(restored?.equals(content), 'deleted file content recoverable byte-identical');
  });

  test('binary file content round-trips through gzip (engine skips these, store still safe)', async () => {
    const file = path.join(root, 'logo.bin');
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    fs.writeFileSync(file, binary);
    await store.recordSnapshot(file, binary);
    const key = dataKeyFor(file);
    const entries = (await store.get()).files[key]?.entries ?? [];
    const restored = await store.readSnapshot(key, entries[0]!.id);
    assert.ok(restored?.equals(binary), 'binary bytes survive gzip round-trip');
    assert.ok(fs.existsSync(path.join(fixturesDir, 'repo-a')), 'fixture repo still present');
  });

  test('retention sweep purges stale files and honors caps', async () => {
    const file = path.join(root, 'churn.ts');
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const e = await store.recordSnapshot(file, Buffer.from(`gen ${i}\n`));
      ids.push(e.id);
    }
    const key = dataKeyFor(file);
    const record = (await store.get()).files[key]!;
    // Simulate the sweep with maxPerFile=3: drop the 3 oldest (last in the newest-first list).
    const result = applyRetention(record, Date.now(), { retentionDays: 5, maxPerFile: 3 });
    assert.equal(result.dropIds.length, 3);
    assert.ok(!result.purgeFile);
    await store.dropEntries(key, result.dropIds);
    const after = (await store.get()).files[key];
    assert.equal(after?.entries.length, 3);
    assert.ok(!ids.slice(0, 3).some((id) => after?.entries.some((e) => e.id === id)), 'oldest dropped');
  });
});
