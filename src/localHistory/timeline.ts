/**
 * Native Timeline integration (per-file history in the Timeline view).
 *
 * Capability-guarded: the Timeline provider registration is not guaranteed
 * present in every engine version our floor supports (types 1.140 may lack
 * it while newer runtimes have it), so we duck-type the call and degrade to
 * "no Timeline" with a log line — Local History keeps working via commands.
 * Runtime shapes are mirrored locally; no dependency on @types/vscode
 * version for this surface.
 */
import * as vscode from 'vscode';
import { info } from '../common/log';
import { dataKeyFor } from './store';
import type { LocalHistoryStore } from './store';

/** Minimal structural mirror of the runtime Timeline API. */
interface DuckTimelineItem {
  label: string;
  timestamp: number;
  description?: string;
  detail?: string;
  iconPath?: vscode.ThemeIcon;
  command?: vscode.Command;
  contextValue?: string;
}

interface DuckTimeline {
  items: DuckTimelineItem[];
  cursor?: string;
}

interface DuckTimelineProvider {
  onDidChangeTimeline?: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;
  provideTimeline(uri: vscode.Uri, options: { cursor?: string; limit?: number }, token?: vscode.CancellationToken): Promise<DuckTimeline | undefined>;
}

type RegisterTimelineProvider = (
  id: string,
  label: string,
  scheme: string | readonly string[],
  provider: DuckTimelineProvider,
) => vscode.Disposable;

export function registerLocalHistoryTimeline(store: LocalHistoryStore): vscode.Disposable | undefined {
  const workspaceAny = vscode.workspace as unknown as {
    registerTimelineProvider?: RegisterTimelineProvider;
  };
  const register = workspaceAny.registerTimelineProvider;
  if (typeof register !== 'function') {
    info('localHistory: Timeline API unavailable in this engine version — using commands only');
    return undefined;
  }

  const provider: DuckTimelineProvider = {
    provideTimeline: async (uri) => {
      if (uri.scheme !== 'file') {
        return undefined;
      }
      const key = dataKeyFor(uri.fsPath);
      const record = (await store.get()).files[key];
      if (!record || record.entries.length === 0) {
        return undefined;
      }
      const items: DuckTimelineItem[] = [];
      for (const entry of record.entries.slice(0, 50)) {
        const when = new Date(entry.ts).toLocaleString();
        if (entry.deleted) {
          items.push({
            label: `Deleted — ${when}`,
            timestamp: Date.parse(entry.ts) || 0,
            description: entry.label ?? 'tombstone',
            iconPath: new vscode.ThemeIcon('trash'),
            contextValue: 'jetgitHistoryDeleted',
            command: {
              command: 'jetgit.localHistory.restoreDeleted',
              title: 'Restore Deleted File from Local History',
            },
          });
          continue;
        }
        items.push({
          label: entry.label ? `${entry.label} — ${when}` : when,
          timestamp: Date.parse(entry.ts) || 0,
          description: `${entry.bytes} bytes`,
          iconPath: new vscode.ThemeIcon(entry.label ? 'tag' : 'history'),
          contextValue: 'jetgitHistoryEntry',
          command: {
            command: 'jetgit.localHistory.showDiffFor',
            title: 'Compare with Local History',
            arguments: [uri, key, entry.id],
          },
        });
      }
      return { items };
    },
  };

  try {
    return register.call(vscode.workspace, 'jetgit', 'JetGit Local History', 'file', provider);
  } catch (err) {
    info(`localHistory: Timeline registration failed (${String(err)}) — using commands only`);
    return undefined;
  }
}
