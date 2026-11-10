/**
 * Typed access to the `jetgit.*` configuration with change events.
 * NOTE: this module NEVER writes settings — JetGit only reads.
 */
import * as vscode from 'vscode';
import type { LogLevel } from './log';

export interface JetGitSettings {
  changelists: {
    autoAssign: boolean;
  };
  blame: {
    mode: 'off' | 'currentLine' | 'wholeFile';
    coloring: boolean;
    format: string;
    ignoreWhitespace: boolean;
    maxFileSizeKB: number;
  };
  localHistory: {
    enabled: boolean;
    retentionDays: number;
    maxSnapshotsPerFile: number;
    maxFileSizeKB: number;
    debounceMs: number;
  };
  shelf: {
    confirmApply: boolean;
  };
  compare: {
    maxCommitEntries: number;
  };
  log: {
    level: LogLevel;
  };
}

const SECTION = 'jetgit';

function read(): JetGitSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const level = cfg.get<LogLevel>('log.level', 'info');
  return {
    changelists: {
      autoAssign: cfg.get<boolean>('changelists.autoAssign', true),
    },
    blame: {
      mode: cfg.get<'off' | 'currentLine' | 'wholeFile'>('blame.mode', 'currentLine'),
      coloring: cfg.get<boolean>('blame.coloring', true),
      format: cfg.get<string>('blame.format', '{author} · {date}'),
      ignoreWhitespace: cfg.get<boolean>('blame.ignoreWhitespace', true),
      maxFileSizeKB: cfg.get<number>('blame.maxFileSizeKB', 1024),
    },
    localHistory: {
      enabled: cfg.get<boolean>('localHistory.enabled', true),
      retentionDays: cfg.get<number>('localHistory.retentionDays', 5),
      maxSnapshotsPerFile: cfg.get<number>('localHistory.maxSnapshotsPerFile', 50),
      maxFileSizeKB: cfg.get<number>('localHistory.maxFileSizeKB', 2048),
      debounceMs: cfg.get<number>('localHistory.debounceMs', 1000),
    },
    shelf: {
      confirmApply: cfg.get<boolean>('shelf.confirmApply', true),
    },
    compare: {
      maxCommitEntries: cfg.get<number>('compare.maxCommitEntries', 200),
    },
    log: {
      level,
    },
  };
}

export class SettingsService {
  private readonly cache: JetGitSettings;
  private readonly listener: vscode.Disposable;
  private readonly changeEmitter = new vscode.EventEmitter<JetGitSettings>();

  /** Fires with the new settings snapshot whenever any `jetgit.*` setting changes. */
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    this.cache = read();
    this.listener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        Object.assign(this.cache, read());
        this.changeEmitter.fire(this.cache);
      }
    });
  }

  get value(): JetGitSettings {
    return this.cache;
  }

  dispose(): void {
    this.listener.dispose();
    this.changeEmitter.dispose();
  }
}
