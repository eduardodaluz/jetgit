/**
 * Local History types + pure retention rules.
 * Retention semantics (IntelliJ parity):
 *  - age: unlabeled entries older than retentionDays are pruned; labeled
 *    entries are kept indefinitely (cleared explicitly or with Clear All);
 *  - count: beyond maxPerFile, oldest UNLABELED entries are dropped first —
 *    labeled entries never get evicted by the count cap;
 *  - a file (tombstoned or otherwise absent from disk) whose newest entry
 *    is older than retentionDays is purged entirely — including its
 *    deleted-file history, matching IntelliJ's bounded retention.
 */
export interface LHEntry {
  /** Sortable id: YYYYMMDDTHHMMSS-<4 hex>. */
  id: string;
  ts: string;
  bytes: number;
  sha256?: string;
  label?: string;
  /** True for deletion tombstones (no payload; previous snapshot is recovery). */
  deleted: boolean;
}

export interface LHFileRecord {
  /** Absolute path, original case. */
  path: string;
  /** Newest first. */
  entries: LHEntry[];
}

export interface LHIndex {
  version: 1;
  files: Record<string, LHFileRecord>;
}

export function createIndex(): LHIndex {
  return { version: 1, files: {} };
}

export function isLoadable(value: unknown): value is LHIndex {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { files?: unknown }).files === 'object' &&
    (value as { files?: unknown }).files !== null
  );
}

export function newEntryId(now: Date = new Date()): string {
  const pad = (n: number, w: number): string => n.toString().padStart(w, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}T${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  return `${stamp}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
}

export interface RetentionOptions {
  retentionDays: number;
  maxPerFile: number;
}

export interface RetentionFileResult {
  /** Entries that survive for this file. */
  keep: LHEntry[];
  /** Entry ids to delete on disk. */
  dropIds: string[];
  /** True when the file record itself should be purged (stale history). */
  purgeFile: boolean;
}

/** Pure per-file retention: newest-first entries in, keep/drop out. */
export function applyRetention(record: LHFileRecord, nowMs: number, opts: RetentionOptions): RetentionFileResult {
  const cutoffMs = nowMs - opts.retentionDays * 24 * 60 * 60 * 1000;
  const ts = (e: LHEntry): number => {
    const parsed = Date.parse(e.ts);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  // Newest entry first — `record.entries` is newest-first by contract.
  const newestTs = record.entries.length > 0 ? ts(record.entries[0] as LHEntry) : 0;
  const fileIsStale = newestTs < cutoffMs;

  const keep: LHEntry[] = [];
  const dropIds: string[] = [];
  let unlabeledKept = 0;
  for (const entry of record.entries) {
    const isLabeled = typeof entry.label === 'string' && entry.label.length > 0;
    if (isLabeled) {
      keep.push(entry); // labels: kept for count AND age
      continue;
    }
    if (ts(entry) < cutoffMs) {
      dropIds.push(entry.id); // age
      continue;
    }
    if (unlabeledKept >= opts.maxPerFile) {
      dropIds.push(entry.id); // count
      continue;
    }
    unlabeledKept += 1;
    keep.push(entry);
  }

  // Keep entries newest-first.
  keep.sort((a, b) => ts(b) - ts(a) || b.id.localeCompare(a.id));
  return { keep, dropIds, purgeFile: fileIsStale };
}
