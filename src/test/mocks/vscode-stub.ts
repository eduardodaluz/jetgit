/**
 * Minimal vscode stub for vitest: unit tests may transitively import modules
 * that `import * as vscode from 'vscode'` (e.g. common/log). The stub only
 * needs to RESOLVE the import — the code paths under test guard all vscode
 * API usage behind undefined checks / injected values.
 */
export class EventEmitter<T> {
  private readonly listeners: Array<(e: T) => unknown> = [];
  readonly event = (listener: (e: T) => unknown): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => void this.listeners.splice(this.listeners.indexOf(listener), 1) };
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) {
      l(data);
    }
  }
  dispose(): void {
    this.listeners.length = 0;
  }
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export const window = {
  showInformationMessage: async (): Promise<string | undefined> => undefined,
  showWarningMessage: async (): Promise<string | undefined> => undefined,
  showErrorMessage: async (): Promise<string | undefined> => undefined,
  showInputBox: async (): Promise<string | undefined> => undefined,
  showQuickPick: async (): Promise<unknown> => undefined,
  createOutputChannel: (): unknown => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }),
};

export const workspace = {
  getConfiguration: (): { get: (k: string, d: unknown) => unknown } => ({ get: (_k, d) => d }),
  onDidChangeConfiguration: (): { dispose(): void } => ({ dispose: () => undefined }),
};

export const commands = {
  registerCommand: (): { dispose(): void } => ({ dispose: () => undefined }),
  executeCommand: async (): Promise<unknown> => undefined,
};

export const extensions = {
  getExtension: (): undefined => undefined,
  onDidChange: (): { dispose(): void } => ({ dispose: () => undefined }),
};
