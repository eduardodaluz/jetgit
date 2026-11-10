/**
 * Logging: single OutputChannel "JetGit". Every git command run is logged at
 * debug level with its duration; user-facing errors always offer "Show Log".
 */
import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'error';

let channel: vscode.OutputChannel | undefined;
let level: LogLevel = 'info';

export function initLog(outputChannel: vscode.OutputChannel, initialLevel: LogLevel): void {
  channel = outputChannel;
  level = initialLevel;
}

export function setLogLevel(newLevel: LogLevel): void {
  level = newLevel;
}

function write(ts: number, prefix: string, message: string): void {
  if (!channel) {
    return;
  }
  const time = new Date(ts).toISOString();
  channel.appendLine(`[${time}] ${prefix} ${message}`);
}

export function debug(message: string): void {
  if (level === 'debug') {
    write(Date.now(), '[debug]', message);
  }
}

export function info(message: string): void {
  if (level !== 'error') {
    write(Date.now(), '[info]', message);
  }
}

export function error(message: string, err?: unknown): void {
  const detail = err instanceof Error ? ` — ${err.message}` : err !== undefined ? ` — ${String(err)}` : '';
  write(Date.now(), '[error]', `${message}${detail}`);
}

/** Wraps an async operation with duration logging at debug level. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    debug(`${label} (${Date.now() - start} ms)`);
  }
}

/** Shows the output channel (used by "Show Log" error actions). */
export function showLog(): void {
  channel?.show(true);
}

/**
 * Standard error surface: logs the error and shows a toast with a
 * "Show Log" action. Returns the actions the user may have clicked.
 */
export async function showError(message: string, err?: unknown): Promise<void> {
  error(message, err);
  const choice = await vscode.window.showErrorMessage(message, 'Show Log');
  if (choice === 'Show Log') {
    showLog();
  }
}
