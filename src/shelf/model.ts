/**
 * Pure shelf index operations over the persisted state shape.
 * A shelf is a named patch (IntelliJ semantics, NOT a stash): it can be
 * applied any number of times, "Save to Shelf" copies without reverting
 * working files, and deleting is soft (trash) so entries are restorable.
 */
import { randomUUID } from 'node:crypto';

export interface ShelfEntry {
  id: string;
  name: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** True when shelve reverted the working files ("Shelve"), false for "Save to Shelf". */
  reverted: boolean;
  /** Files contained in the patch (parsed at creation time). */
  files: string[];
  /** Patch size in bytes. */
  bytes: number;
  /** How many of `files` were untracked at shelve time. */
  untrackedCount: number;
  /** Non-null while the entry sits in the trash (soft-deleted). */
  deletedAt: string | null;
}

export interface ShelfIndex {
  version: 1;
  shelves: ShelfEntry[];
}

export function createIndex(): ShelfIndex {
  return { version: 1, shelves: [] };
}

export function isLoadable(value: unknown): value is ShelfIndex {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { shelves?: unknown }).shelves)
  );
}

export function newEntryId(): string {
  return `sh-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

export function findById(index: ShelfIndex, id: string): ShelfEntry | undefined {
  return index.shelves.find((s) => s.id === id);
}

/** Live shelves, newest first; trash entries excluded. */
export function listLive(index: ShelfIndex): ShelfEntry[] {
  return index.shelves
    .filter((s) => s.deletedAt === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listTrash(index: ShelfIndex): ShelfEntry[] {
  return index.shelves
    .filter((s) => s.deletedAt !== null)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}

export function addEntry(index: ShelfIndex, entry: ShelfEntry): ShelfIndex {
  return { ...index, shelves: [entry, ...index.shelves] };
}

export function rename(index: ShelfIndex, id: string, name: string): ShelfIndex {
  return {
    ...index,
    shelves: index.shelves.map((s) => (s.id === id ? { ...s, name } : s)),
  };
}

/** Soft-delete: keeps the entry (and its patch file, moved to .trash). */
export function trash(index: ShelfIndex, id: string, now: () => Date = () => new Date()): ShelfIndex {
  return {
    ...index,
    shelves: index.shelves.map((s) => (s.id === id && s.deletedAt === null ? { ...s, deletedAt: now().toISOString() } : s)),
  };
}

export function restore(index: ShelfIndex, id: string): ShelfIndex {
  return {
    ...index,
    shelves: index.shelves.map((s) => (s.id === id ? { ...s, deletedAt: null } : s)),
  };
}

/** Hard-delete (from trash): removes the entry entirely. */
export function purge(index: ShelfIndex, id: string): ShelfIndex {
  return { ...index, shelves: index.shelves.filter((s) => s.id !== id) };
}
