import * as vscode from 'vscode';

/** Every user-tunable knob of the extension, fully resolved with defaults applied. */
export interface CfConfig {
  /** Codeforces handle used for verdict polling. */
  handle: string;
  /** Absolute path to the C++ template copied into new solution files. */
  templatePath: string;
  /** Absolute path to the local Google Chrome executable. */
  chromePath: string;
  /** Command used to compile a solution for local testing. */
  compilerCommand: string;
  /** Codeforces `programTypeId` posted when submitting. */
  cfCompilerId: string;
  /** Per-testcase timeout for the local runner. */
  timeoutMs: number;
  /** Optional debugger/sanitizer host command used instead of running the binary directly. */
  debugCommand: string;
}

export const CONFIG_SECTION = 'cfVscode';

const DEFAULT_COMPILER = 'g++ -std=gnu++20 -O2 -Wall -Wextra';

/** Reads the `cfVscode.*` settings, defensively normalising each value. */
export function readConfig(): CfConfig {
  const section = vscode.workspace.getConfiguration(CONFIG_SECTION);

  const asString = (key: string, fallback = ''): string => {
    const raw = section.get<unknown>(key, fallback);
    return typeof raw === 'string' ? raw.trim() : fallback;
  };

  const rawTimeout = section.get<unknown>('timeoutMs', 3000);
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout >= 100
      ? Math.round(rawTimeout)
      : 3000;

  const compilerCommand = asString('compilerCommand', DEFAULT_COMPILER) || DEFAULT_COMPILER;
  const chromePath = asString('chromePath');

  return {
    handle: asString('handle'),
    templatePath: asString('templatePath'),
    chromePath,
    compilerCommand,
    cfCompilerId: asString('cfCompilerId', '89') || '89',
    timeoutMs,
    debugCommand: asString('debugCommand'),
  };
}

/** Reads a single setting (used by commands that patch configuration on the fly). */
export function readSetting<T>(key: keyof CfConfig): T | undefined {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<T>(key);
}

/** Persists a setting into the workspace configuration, creating it if needed. */
export async function updateSetting(key: keyof CfConfig, value: unknown): Promise<void> {
  const section = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await section.update(key, value, target);
}
