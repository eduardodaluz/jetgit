/**
 * Shelf persistence at `<gitDir>/jetgit/shelf/`:
 *   index.json          — ShelfIndex
 *   <id>.patch          — concatenated unified patch (raw Buffer, never text)
 *   .trash/<id>.patch   — soft-deleted patches, restorable
 * Patches live next to the repo (like IntelliJ's .idea/shelf) because they
 * can be large and binary — bulk data stays out of globalStorage and the
 * shelves stay tied to the clone where they semantically belong.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { JsonFile } from '../common/jsonFile';
import { atomicWrite } from '../common/fsutil';
import { debug, error } from '../common/log';
import { createIndex, isLoadable, type ShelfEntry, type ShelfIndex } from './model';

export class ShelfStore {
  private readonly indexFile: JsonFile<ShelfIndex>;
  private readonly shelfDir: string;
  private readonly trashDir: string;

  constructor(gitDir: string) {
    this.shelfDir = path.join(gitDir, 'jetgit', 'shelf');
    this.trashDir = path.join(this.shelfDir, '.trash');
    const indexPath = path.join(this.shelfDir, 'index.json');
    this.indexFile = new JsonFile<ShelfIndex>(
      indexPath,
      async () => {
        const parsed: unknown = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
        if (!isLoadable(parsed)) {
          error('shelf index.json has an unknown schema version; starting fresh (file left untouched)');
          return createIndex();
        }
        return parsed;
      },
      () => createIndex(),
    );
  }

  async get(): Promise<ShelfIndex> {
    return this.indexFile.get();
  }

  set(index: ShelfIndex): void {
    this.indexFile.set(index);
  }

  flush(): Promise<void> {
    return this.indexFile.flush();
  }

  patchPath(id: string): string {
    return path.join(this.shelfDir, `${id}.patch`);
  }

  trashPath(id: string): string {
    return path.join(this.trashDir, `${id}.patch`);
  }

  /** Writes the patch atomically; patches are Buffers end-to-end (no EOL translation). */
  async writePatch(id: string, patch: Buffer): Promise<number> {
    await atomicWrite(this.patchPath(id), patch);
    debug(`shelf: wrote patch ${id} (${patch.length} bytes)`);
    return patch.length;
  }

  async readPatch(entry: ShelfEntry): Promise<Buffer | undefined> {
    try {
      return await fsp.readFile(this.patchPath(entry.id));
    } catch {
      return undefined;
    }
  }

  /** Soft delete: move the patch file into .trash/ (index update is the caller's job). */
  async moveToTrash(id: string): Promise<void> {
    await fsp.mkdir(this.trashDir, { recursive: true });
    try {
      await fsp.rename(this.patchPath(id), this.trashPath(id));
    } catch {
      // patch may already be gone; keep going — the index records the state
    }
  }

  /** Restore from trash: move the patch back. */
  async restoreFromTrash(id: string): Promise<boolean> {
    try {
      await fsp.rename(this.trashPath(id), this.patchPath(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Hard delete the trash file (purge). */
  async purgePatch(id: string): Promise<void> {
    await fsp.rm(this.trashPath(id), { force: true });
  }

  /** True when the patch file for an entry is missing (rendered as "[missing patch]"). */
  async patchMissing(entry: ShelfEntry): Promise<boolean> {
    if (entry.deletedAt !== null) {
      try {
        await fsp.access(this.trashPath(entry.id));
        return false;
      } catch {
        return true;
      }
    }
    try {
      await fsp.access(this.patchPath(entry.id));
      return false;
    } catch {
      return true;
    }
  }
}
