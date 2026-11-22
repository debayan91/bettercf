/**
 * Minimal `vscode` stand-in for headless verification of the pure-logic modules
 * (scraper parsing, runner engine, layout payload). The extension itself always runs
 * inside a real VS Code host; this shim only exists so the test runner can import the
 * modules without Electron.
 */
class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((item) => item !== listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

class Uri {
  private constructor(
    readonly fsPath: string,
    readonly scheme: string = 'file',
  ) {}

  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }

  static parse(value: string): Uri {
    return new Uri(value.replace(/^file:\/\//, ''), value.split(':')[0] ?? 'file');
  }

  toString(): string {
    return this.fsPath;
  }
}

const writtenChunks: string[] = [];

/** Mirrors the defaults declared in package.json so readConfig() behaves identically. */
const CONFIG_DEFAULTS: Record<string, unknown> = {
  'cfVscode.chromePath': '',
  'cfVscode.compilerCommand': 'g++ -std=gnu++20 -O2 -Wall -Wextra',
  'cfVscode.cfCompilerId': '89',
  'cfVscode.timeoutMs': 3000,
  'cfVscode.handle': '',
  'cfVscode.templatePath': '',
  'cfVscode.debugCommand': '',
};

const workspace: Record<string, unknown> = {
  workspaceFolders: undefined as unknown,
  getConfiguration: (section: string) => ({
    get: (key: string, fallback?: unknown) => {
      const override = (globalThis as Record<string, unknown>)[`__cfg_${section}_${key}`];
      if (override === undefined) {
        const declared = CONFIG_DEFAULTS[`${section}.${key}`];
        return declared === undefined ? fallback : declared;
      }
      return override;
    },
    inspect: () => ({ workspaceValue: undefined }),
    update: async (key: string, value: unknown) => {
      (globalThis as Record<string, unknown>)[`__cfg_${section}_${key}`] = value;
    },
  }),
  onDidSaveTextDocument: () => ({ dispose(): void {} }),
};

const window: Record<string, unknown> = {
  activeTextEditor: undefined,
  visibleTextEditors: [],
  createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show: () => undefined, dispose: () => undefined }),
  createTerminal: () => ({
    show: () => undefined,
    sendText: () => undefined,
    dispose: () => undefined,
    creationOptions: {},
  }),
  showTextDocument: async () => {
    throw new Error('not available in the harness');
  },
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
    task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose(): void {} }) }),
  onDidChangeActiveTextEditor: () => ({ dispose(): void {} }),
  onDidCloseTerminal: () => ({ dispose(): void {} }),
  createOutputChannel: () => ({ appendLine: (line: string) => void writtenChunks.push(line), show: () => undefined, dispose: () => undefined }),
  createWebviewPanel: () => {
    throw new Error('webviews are unavailable in the harness');
  },
  ViewColumn: { One: 1, Two: 2, Three: 3 },
  ProgressLocation: { Notification: 15 },
  TerminalLocation: { Editor: 2 },
};

const commands = {
  executeCommand: async (command: string, ...args: unknown[]) => {
    (globalThis as Record<string, unknown>).__lastCommand = { command, args };
    return undefined;
  },
  registerCommand: (command: string) => {
    const registered = ((globalThis as Record<string, unknown>).__registeredCommands ?? []) as string[];
    registered.push(command);
    (globalThis as Record<string, unknown>).__registeredCommands = registered;
    return { dispose(): void {} };
  },
};

export {
  EventEmitter,
  Uri,
  workspace,
  window,
  commands,
  writtenChunks,
};

export const ViewColumn = { One: 1, Two: 2, Three: 3 };
export const ProgressLocation = { Notification: 15 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const TerminalLocation = { Panel: 1, Editor: 2 };
export const env = { openExternal: async () => true };

export interface Disposable {
  dispose(): void;
}

export const StatusBarAlignment = { Left: 1, Right: 2 };
