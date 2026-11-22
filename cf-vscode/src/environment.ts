import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Discover browsers and C++ compilers for automatic browser selection and setup checks.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface DetectedChrome {
  path: string;
  /** How it was found, for the Doctor report. */
  source: 'configured' | 'known-path' | 'which';
}

export interface DetectedCompiler {
  /** Executable path or bare command name that resolved. */
  command: string;
  version: string;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isExecutable(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs a command once with a hard timeout and resolves its combined output. */
export function runCapture(command: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let child: import('node:child_process').ChildProcess | undefined;
    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(null);
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output = (output + chunk).slice(-65536);
    });
    child.stderr?.on('data', (chunk: string) => {
      output = (output + chunk).slice(-65536);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? output : null));
  });
}

/* -------------------------------------------------------------------------- */
/* Chrome discovery                                                           */
/* -------------------------------------------------------------------------- */

function chromeCandidatesForPlatform(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (platform === 'win32') {
    const roots = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const candidates: string[] = [];
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Google/Chrome/Application/chrome.exe'),
        path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
        path.join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      );
    }
    return candidates;
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ];
}

async function resolveFromPath(names: string[]): Promise<string | null> {
  for (const name of names) {
    const output = await runCapture(process.platform === 'win32' ? 'where' : 'which', [name], 2500);
    const first = output?.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
    if (first && isExecutable(first)) {
      return first;
    }
  }
  return null;
}

/**
 * Finds a usable Chrome. Order of preference: the user's configured path (if it exists), known install locations, then `PATH`.
 */
export async function detectChrome(configuredPath?: string): Promise<DetectedChrome | null> {
  if (configuredPath && isExecutable(configuredPath)) {
    return { path: configuredPath, source: 'configured' };
  }

  const candidates = chromeCandidatesForPlatform(process.platform, os.homedir());
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return { path: candidate, source: 'known-path' };
    }
  }

  const names =
    process.platform === 'win32'
      ? ['chrome.exe', 'msedge.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  const fromPath = await resolveFromPath(names);
  if (fromPath) {
    return { path: fromPath, source: 'which' };
  }
  return null;
}

export function chromeCandidates(): string[] {
  return chromeCandidatesForPlatform(process.platform, os.homedir());
}

/* -------------------------------------------------------------------------- */
/* Compiler discovery                                                         */
/* -------------------------------------------------------------------------- */

async function probeCompiler(command: string): Promise<DetectedCompiler | null> {
  const output = await runCapture(command, ['--version'], 4000);
  if (!output) {
    return null;
  }
  const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine || !/(g\+\+|clang|GCC|Apple)/i.test(firstLine)) {
    return null;
  }
  return { command, version: firstLine };
}

/** Probes the usual C++ compilers, honouring an already-configured command first. */
export async function detectCompiler(configuredCommand?: string): Promise<DetectedCompiler | null> {
  const tried = new Set<string>();
  const candidates: string[] = [];
  if (configuredCommand) {
    const executable = configuredCommand.split(/\s+/)[0];
    if (executable) {
      candidates.push(executable);
      tried.add(executable);
    }
  }
  for (const name of ['g++', 'clang++', 'c++']) {
    if (!tried.has(name)) {
      candidates.push(name);
      tried.add(name);
    }
  }
  // Windows: a MinGW install is often not on PATH but present under the default roots.
  if (process.platform === 'win32') {
    for (const root of ['C:\\mingw64\\bin\\g++.exe', 'C:\\msys64\\mingw64\\bin\\g++.exe']) {
      if (isExecutable(root) && !tried.has(root)) {
        candidates.push(root);
        tried.add(root);
      }
    }
  }

  for (const candidate of candidates) {
    const probe = await probeCompiler(candidate);
    if (probe) {
      return probe;
    }
  }
  return null;
}

export function compilerCandidates(): string[] {
  return ['g++', 'clang++', 'c++'];
}

