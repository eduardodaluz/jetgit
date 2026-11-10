/**
 * Persistence for changelists at `<gitDir>/jetgit/changelists.json`.
 * Per-clone IDE metadata (like an .idea directory): survives workspace-data
 * clearing, naturally per-repo in multi-root workspaces and per-worktree in
 * git worktrees (state follows the resolved git dir).
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { JsonFile } from '../common/jsonFile';
import { debug, error } from '../common/log';
import { createState, ensureInvariants, isLoadable, type ChangelistsState } from './model';

export class ChangelistsStore {
  private readonly file: JsonFile<ChangelistsState>;
  private readonly filePath: string;

  constructor(gitDir: string) {
    this.filePath = path.join(gitDir, 'jetgit', 'changelists.json');
    this.file = new JsonFile<ChangelistsState>(
      this.filePath,
      async () => {
        const parsed: unknown = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
        if (!isLoadable(parsed)) {
          // Unknown schema version: keep the file untouched, start fresh in memory.
          error('changelists.json has an unknown schema version; starting fresh (file left untouched)');
          return createState();
        }
        return ensureInvariants(parsed);
      },
      () => createState(),
    );
  }

  async get(): Promise<ChangelistsState> {
    return this.file.get();
  }

  set(state: ChangelistsState): void {
    debug(`changelists: persisting ${state.changelists.length} changelist(s)`);
    this.file.set(state);
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}
