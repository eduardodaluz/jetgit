/**
 * Local History storage — works WITHOUT any git repository, survives
 * "Clear Editor Workspace Data" (globalStorage, not workspaceStorage).
 * Layout:
 *   <root>/index.json              — LHIndex, keyed by dataKey
 *   <root>/data/<dataKey>/<id>.gz  — full snapshot, gzip
 * dataKey = sha1(case-folded absolute path)[0..16] — one key for the index
 * map and the data directory; the original path lives in the record.
 * Full snapshots + gzip: any point restorable with zero reconstruction
 * logic (delta chains deferred). Never blocks a save — callers treat every
 * method as fire-and-forget and swallow errors into the log (engine
 * contract); the store itself only throws on unrecoverable IO, which the
 * engine catches.
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { JsonFile } from '../common/jsonFile';
import { atomicWrite, mkdirp } from '../common/fsutil';
import { keyForAbs } from '../common/paths';
import { debug, error } from '../common/log';
import { createIndex, isLoadable, newEntryId, type LHEntry, type LHIndex } from './model';

export function dataKeyFor(absolutePath: string): string {
  return createHash('sha1').update(keyForAbs(absolutePath), 'utf8').digest('hex').slice(0, 16);
}

export class LocalHistoryStore {
  private readonly indexFile: JsonFile<LHIndex>;
  private readonly dataDir: string;

  constructor(rootDir: string) {
    this.dataDir = path.join(rootDir, 'data');
    const indexPath = path.join(rootDir, 'index.json');
    this.indexFile = new JsonFile<LHIndex>(
      indexPath,
      async () => {
        const parsed: unknown = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
        if (!isLoadable(parsed)) {
          error('local history index.json has an unknown schema version; starting fresh (file left untouched)');
          return createIndex();
        }
        return parsed;
      },
      () => createIndex(),
    );
  }

  async get(): Promise<LHIndex> {
    return this.indexFile.get();
  }

  set(index: LHIndex): void {
    this.indexFile.set(index);
  }

  flush(): Promise<void> {
    return this.indexFile.flush();
  }

  /** Full content snapshot of a file at this instant. */
  async recordSnapshot(absolutePath: string, content: Buffer, label?: string): Promise<LHEntry> {
    const key = dataKeyFor(absolutePath);
    const id = newEntryId();
    await mkdirp(path.join(this.dataDir, key));
    await atomicWrite(this.dataPath(key, id), zlib.gzipSync(content));

    const index = await this.get();
    const record = index.files[key];
    const entry: LHEntry = {
      id,
      ts: new Date().toISOString(),
      bytes: content.length,
      sha256: sha256Hex(content),
      label: label ?? undefined,
      deleted: false,
    };
    index.files[key] = {
      path: absolutePath,
      entries: [entry, ...(record?.entries ?? [])],
    };
    this.set(index);
    debug(`localHistory: snapshot ${absolutePath} (${content.length} bytes)`);
    return entry;
  }

  /** Marks a file as deleted; the PREVIOUS snapshot is the recovery source. */
  async recordTombstone(absolutePath: string): Promise<void> {
    const key = dataKeyFor(absolutePath);
    const index = await this.get();
    const record = index.files[key];
    if (!record || record.entries.length === 0) {
      return; // never snapshotted — nothing to remember
    }
    if (record.entries[0]?.deleted) {
      return; // tombstone already recorded
    }
    const entry: LHEntry = {
      id: newEntryId(),
      ts: new Date().toISOString(),
      bytes: 0,
      deleted: true,
    };
    index.files[key] = { ...record, entries: [entry, ...record.entries] };
    this.set(index);
    debug(`localHistory: tombstone ${absolutePath}`);
  }

  /** Gunzips a snapshot's content. */
  async readSnapshot(key: string, entryId: string): Promise<Buffer | undefined> {
    try {
      const gz = await fsp.readFile(this.dataPath(key, entryId));
      return zlib.gunzipSync(gz);
    } catch {
      return undefined;
    }
  }

  /** Files whose newest entry is a tombstone — candidates for restore-deleted. */
  async tombstonedPaths(): Promise<Array<{ key: string; path: string; lastEntry: LHEntry }>> {
    const index = await this.get();
    const out: Array<{ key: string; path: string; lastEntry: LHEntry }> = [];
    for (const [key, record] of Object.entries(index.files)) {
      const newest = record.entries[0];
      if (newest?.deleted) {
        out.push({ key, path: record.path, lastEntry: newest });
      }
    }
    return out.sort((a, b) => (b.lastEntry.ts ?? '').localeCompare(a.lastEntry.ts ?? ''));
  }

  /** Drops a file record and its whole snapshot directory (retention). */
  async purgeFile(key: string): Promise<void> {
    const index = await this.get();
    delete index.files[key];
    this.set(index);
    await fsp.rm(path.join(this.dataDir, key), { recursive: true, force: true });
  }

  /** Drops individual entries (count-based prune) and their .gz files. */
  async dropEntries(key: string, entryIds: string[]): Promise<void> {
    const index = await this.get();
    const record = index.files[key];
    if (!record) {
      return;
    }
    index.files[key] = { ...record, entries: record.entries.filter((e) => !entryIds.includes(e.id)) };
    this.set(index);
    for (const id of entryIds) {
      await fsp.rm(this.dataPath(key, id), { force: true });
    }
  }

  dataPath(key: string, id: string): string {
    return path.join(this.dataDir, key, `${id}.gz`);
  }

  async clearAll(): Promise<void> {
    await fsp.rm(this.dataDir, { recursive: true, force: true });
    const index = await this.get();
    index.files = {};
    this.set(index);
    await this.flush();
  }

  /** Aggregated storage usage (approximate: stat()s each snapshot). */
  async storageUsage(): Promise<{
    files: number;
    snapshots: number;
    totalBytes: number;
    top: Array<{ path: string; bytes: number; count: number }>;
  }> {
    const index = await this.get();
    let snapshots = 0;
    let totalBytes = 0;
    const top: Array<{ path: string; bytes: number; count: number }> = [];
    for (const [key, record] of Object.entries(index.files)) {
      let disk = 0;
      for (const e of record.entries) {
        if (e.deleted) {
          continue;
        }
        snapshots += 1;
        try {
          disk += (await fsp.stat(this.dataPath(key, e.id))).size;
        } catch {
          disk += e.bytes;
        }
      }
      totalBytes += disk;
      top.push({ path: record.path, bytes: disk, count: record.entries.length });
    }
    top.sort((a, b) => b.bytes - a.bytes);
    return { files: Object.keys(index.files).length, snapshots, totalBytes, top: top.slice(0, 5) };
  }
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
