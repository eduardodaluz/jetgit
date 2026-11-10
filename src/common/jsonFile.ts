/**
 * Debounced load/save wrapper for small JSON state files (changelists index,
 * shelf index, local history index). All writes go through atomicWrite.
 * Pure Node.
 */
import { atomicWriteJson, fileExists } from './fsutil';
import { debounce } from './async';

const SAVE_DEBOUNCE_MS = 500;

export class JsonFile<T extends object> {
  private data: T | undefined;
  private readonly saveDebounced: ((...args: []) => void) & { cancel(): void };
  private pendingSave: Promise<void> = Promise.resolve();

  /**
   * @param filePath     absolute path of the JSON file
   * @param loadExisting called when the file exists on disk
   * @param empty        initial state when the file does not exist yet
   */
  constructor(
    private readonly filePath: string,
    private readonly loadExisting: () => Promise<T>,
    private readonly empty: () => T,
  ) {
    this.saveDebounced = debounce(() => {
      this.pendingSave = this.writeNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Loads from disk once; subsequent reads are served from memory. */
  async get(): Promise<T> {
    if (this.data === undefined) {
      this.data = (await fileExists(this.filePath)) ? await this.loadExisting() : this.empty();
    }
    return this.data;
  }

  /** Updates in-memory state and schedules a debounced atomic write. */
  set(value: T): void {
    this.data = value;
    this.saveDebounced();
  }

  /** Ensures the current in-memory state is on disk (tests, teardown). */
  async flush(): Promise<void> {
    this.saveDebounced.cancel();
    this.pendingSave = this.writeNow();
    await this.pendingSave;
  }

  private async writeNow(): Promise<void> {
    if (this.data === undefined) {
      return;
    }
    await atomicWriteJson(this.filePath, this.data);
  }
}
