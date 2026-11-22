import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { CfConfig } from './config';
import { problemDir } from './scraper';

/* -------------------------------------------------------------------------- */
/* ANSI helpers                                                               */
/* -------------------------------------------------------------------------- */

const ESC = '\u001b[';
const ANSI = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  grey: `${ESC}90m`,
  white: `${ESC}97m`,
  clear: `${ESC}2J${ESC}3J${ESC}H`,
} as const;

type Style = keyof typeof ANSI | 'plain';

function paint(text: string, style: Style): string {
  if (style === 'plain') {
    return text;
  }
  return `${ANSI[style]}${text}${ANSI.reset}`;
}

/* -------------------------------------------------------------------------- */
/* Pseudoterminal                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A VS Code terminal backed by a raw stream: no shell, no prompt, no echo. ANSI sequences are
 * rendered natively, so compile errors keep their colours and every run starts from a clean
 * screen.
 */
export class RunnerPseudoTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  private disposed = false;
  private renderedLines = 0;

  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  readonly onDidClose: vscode.Event<number> = this.closeEmitter.event;

  /** Raw sink for anything that should appear verbatim. */
  write(text: string): void {
    if (this.disposed) {
      return;
    }
    this.renderedLines += (text.match(/\n/g) ?? []).length;
    this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
  }

  writeLine(text = '', style: Style = 'plain'): void {
    this.write(style === 'plain' ? `${text}\n` : `${paint(text, style)}\n`);
  }

  /** Clears the terminal when it already carries output. */
  clearIfNeeded(): void {
    if (this.disposed || this.renderedLines === 0) {
      return;
    }
    this.writeEmitter.fire(ANSI.clear);
    this.renderedLines = 0;
  }

  /** Full reset used before a fresh test batch. */
  hardReset(): void {
    if (this.disposed) {
      return;
    }
    this.writeEmitter.fire(ANSI.clear);
    this.renderedLines = 0;
  }

  open(): void {
    /* nothing to allocate */
  }

  close(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.closeEmitter.fire(0);
  }

  handleInput(): void {
    // Read-only surface: keystrokes are intentionally ignored so Ctrl+C cannot corrupt a run.
  }

  setDimensions(): void {
    /* renderer handles wrapping */
  }

  dispose(): void {
    this.close();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* Command line tokenising                                                    */
/* -------------------------------------------------------------------------- */

/** Splits a command string honouring single/double quotes and backslash escapes. */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? '';
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && i + 1 < command.length) {
        i += 1;
        current += command[i] ?? '';
      } else {
        current += char;
      }
      hasContent = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    if (char === '\\' && i + 1 < command.length) {
      i += 1;
      current += command[i] ?? '';
      hasContent = true;
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) {
    tokens.push(current);
  }
  return tokens;
}

/** Quotes a single argument for a POSIX shell. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* -------------------------------------------------------------------------- */
/* Process helpers                                                            */
/* -------------------------------------------------------------------------- */

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  elapsedMs: number;
  spawnError?: string;
}

/** Kills a process and every child it spawned. */
function killTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

function execProcess(
  command: string,
  args: string[],
  options: { cwd: string; stdin?: string; timeoutMs: number; shellCommand?: boolean },
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const finish = (result: Partial<ExecResult> & { code: number | null; signal: NodeJS.Signals | null }): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        elapsedMs: Date.now() - startedAt,
        timedOut,
        ...result,
      });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: options.shellCommand === true,
      });
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        code: null,
        signal: null,
        timedOut: false,
        elapsedMs: Date.now() - startedAt,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer: NodeJS.Timeout | undefined =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, options.timeoutMs)
        : undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    child.on('error', (error) => {
      finish({ code: null, signal: null, spawnError: error.message });
    });

    child.on('close', (code, signal) => {
      finish({ code, signal });
    });

    if (options.stdin !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Verdict / diff rendering                                                   */
/* -------------------------------------------------------------------------- */

export type TestVerdict = 'PASS' | 'FAIL' | 'TLE' | 'RE' | 'NO_OUTPUT';

const VERDICT_STYLE: Record<TestVerdict, Style> = {
  PASS: 'green',
  FAIL: 'red',
  TLE: 'yellow',
  RE: 'magenta',
  NO_OUTPUT: 'yellow',
};

/** Trailing-whitespace-insensitive comparison used by every judge. */
export function normaliseOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
}

export function outputsMatch(actual: string, expected: string): boolean {
  return normaliseOutput(actual) === normaliseOutput(expected);
}

/** First differing line number (1-based) or 0 when the outputs agree. */
export function firstDiffLine(actual: string, expected: string): number {
  const a = normaliseOutput(actual).split('\n');
  const b = normaliseOutput(expected).split('\n');
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? '') !== (b[i] ?? '')) {
      return i + 1;
    }
  }
  return 0;
}

function renderBlock(label: string, text: string, highlightLine: number | null, style: Style): string[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  if (text.length === 0) {
    lines.length = 0;
    lines.push('');
  }
  const out: string[] = [];
  out.push(paint(`  ${label}`, style));
  const width = String(lines.length).length;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const marker = highlightLine !== null && lineNo === highlightLine ? '>' : ' ';
    const rendered = `${marker} ${String(lineNo).padStart(width, ' ')} | ${line}`;
    out.push(
      highlightLine !== null && lineNo === highlightLine ? paint(rendered, style) : paint(rendered, 'grey'),
    );
  });
  if (lines.length === 1 && lines[0] === '') {
    out.push(paint('    (empty)', 'grey'));
  }
  return out;
}

interface TestCase {
  name: string;
  input: string;
  expected?: string;
}

interface BinaryResult {
  verdict: TestVerdict;
  detail?: string;
  stdout: string;
  elapsedMs: number;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export interface ActiveSolution {
  root: string;
  contestId: string;
  index: string;
  /** Absolute path of the `.cpp` file. */
  file: string;
}

export class Runner implements vscode.Disposable {
  private terminal: vscode.Terminal | null = null;
  private pty: RunnerPseudoTerminal | null = null;
  private busy = false;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly config: () => CfConfig) {
    // If the user closes the "CF Runner" tab, drop the dead pty so the next run re-creates it
    // instead of writing into a disposed emitter.
    this.subscriptions.push(
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === this.terminal) {
          this.terminal = null;
          this.pty = null;
        }
      }),
    );
  }

  /** True while a test batch or submission poll owns the terminal. */
  get isBusy(): boolean {
    return this.busy;
  }

  /** The single right-hand terminal, created on demand and always re-used. */
  private ensureTerminal(): RunnerPseudoTerminal {
    if (this.terminal && this.pty) {
      try {
        // Accessing creationOptions throws once the terminal has been disposed.
        void this.terminal.creationOptions;
        return this.pty;
      } catch {
        this.terminal = null;
        this.pty = null;
      }
    }
    const pty = new RunnerPseudoTerminal();
    const terminal = vscode.window.createTerminal({
      name: 'CF Runner',
      pty,
      location: { viewColumn: vscode.ViewColumn.Three },
      isTransient: false,
    });
    this.pty = pty;
    this.terminal = terminal;
    return pty;
  }

  /** Reveals / creates the runner in column three. */
  show(): RunnerPseudoTerminal {
    const pty = this.ensureTerminal();
    this.terminal?.show(false);
    return pty;
  }

  /** Writes into the runner without creating a batch (used by the verdict poller). */
  write(text: string): void {
    this.ensureTerminal().write(text);
  }

  writeLine(text = '', style: Style = 'plain'): void {
    this.ensureTerminal().writeLine(text, style);
  }

  /** Marks the terminal busy so overlapping runs cannot interleave output. */
  acquire(): boolean {
    if (this.busy) {
      return false;
    }
    this.busy = true;
    return true;
  }

  release(): void {
    this.busy = false;
  }

  /** Reads `N.in` / `N.out` pairs from the problem cache directory. */
  static async loadTestCases(solution: ActiveSolution): Promise<TestCase[]> {
    const dir = problemDir(solution.root, solution.contestId, solution.index);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const inputs = entries
      .map((name) => /^(\d+)\.in$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ name: match[0], order: Number.parseInt(match[1] ?? '0', 10) }))
      .sort((a, b) => a.order - b.order);

    const tests: TestCase[] = [];
    for (const entry of inputs) {
      const input = await fs.readFile(path.join(dir, entry.name), 'utf8').catch(() => '');
      const outName = entry.name.replace(/\.in$/, '.out');
      const expected = entries.includes(outName)
        ? await fs.readFile(path.join(dir, outName), 'utf8').catch(() => undefined)
        : undefined;
      const label = entry.name.replace(/\.in$/, '');
      tests.push(expected === undefined ? { name: label, input } : { name: label, input, expected });
    }
    return tests;
  }

  /** Absolute path of the binary built for a solution (`.exe` on Windows). */
  static binaryPath(solution: ActiveSolution): string {
    return path.join(
      problemDir(solution.root, solution.contestId, solution.index),
      process.platform === 'win32' ? 'sol.exe' : 'sol',
    );
  }

  /** Compiles the solution into `.cp/{index}/sol`. Returns the binary path or `null` on error. */
  private async compile(solution: ActiveSolution, pty: RunnerPseudoTerminal): Promise<string | null> {
    const cfg = this.config();
    const dir = problemDir(solution.root, solution.contestId, solution.index);
    await fs.mkdir(dir, { recursive: true });

    const binary = Runner.binaryPath(solution);
    // A stale binary from another platform (or a half-written one) must never be executed.
    await fs.rm(binary, { force: true }).catch(() => undefined);
    const args = splitCommand(cfg.compilerCommand);
    const compiler = args.shift();
    if (!compiler) {
      pty.writeLine('Compile failed: cfVscode.compilerCommand is empty.', 'red');
      return null;
    }
    const debugExtras = cfg.debugCommand ? ['-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : [];
    const fullArgs = [...args, ...debugExtras, solution.file, '-o', binary];

    pty.writeLine(`Compiling ${path.basename(solution.file)}`, 'bold');
    pty.writeLine(`  ${cfg.compilerCommand}${debugExtras.length ? ` ${debugExtras.join(' ')}` : ''}`, 'grey');

    const result = await execProcess(compiler, fullArgs, {
      cwd: dir,
      timeoutMs: 120_000,
    });

    const diagnostics = `${result.stderr}${result.stdout}`.trim();
    if (result.spawnError) {
      pty.writeLine(`Compile failed: ${result.spawnError}`, 'red');
      pty.writeLine('  Check that your compiler is on PATH, or edit cfVscode.compilerCommand.', 'grey');
      return null;
    }
    if (result.timedOut) {
      pty.writeLine('Compile failed: compiler timed out after 120s.', 'red');
      return null;
    }
    if (result.code !== 0) {
      pty.writeLine(`Compile failed (exit ${result.code ?? 'signal ' + String(result.signal)}) in ${result.elapsedMs} ms`, 'red');
      if (diagnostics) {
        for (const line of diagnostics.split('\n')) {
          pty.writeLine(`  ${line}`, line.includes('error:') ? 'red' : 'grey');
        }
      }
      return null;
    }
    if (diagnostics) {
      for (const line of diagnostics.split('\n')) {
        pty.writeLine(`  ${line}`, line.includes('warning:') ? 'yellow' : 'grey');
      }
    }
    pty.writeLine(`Compiled in ${result.elapsedMs} ms`, 'grey');
    return binary;
  }

  private async runSingle(
    binary: string,
    test: TestCase,
    solution: ActiveSolution,
  ): Promise<BinaryResult> {
    const cfg = this.config();
    const dir = problemDir(solution.root, solution.contestId, solution.index);
    const isDebug = cfg.debugCommand.length > 0;

    let command: string;
    let args: string[];
    let shellCommand = false;
    let timeoutMs = cfg.timeoutMs;

    if (isDebug) {
      const expanded = cfg.debugCommand.includes('{binary}')
        ? cfg.debugCommand.replace(/\{binary\}/g, shellQuote(binary))
        : `${cfg.debugCommand} ${shellQuote(binary)}`;
      command = process.platform === 'win32' ? expanded : '/bin/sh';
      args = process.platform === 'win32' ? [] : ['-c', expanded];
      shellCommand = process.platform === 'win32';
      // Debuggers and sanitiser builds start slowly; give them room without hiding real TLEs.
      timeoutMs = Math.max(cfg.timeoutMs * 4, 10_000);
    } else {
      command = binary;
      args = [];
    }

    const result = await execProcess(command, args, {
      cwd: dir,
      stdin: test.input,
      timeoutMs,
      shellCommand,
    });

    if (result.spawnError) {
      return { verdict: 'RE', detail: result.spawnError, stdout: result.stdout, elapsedMs: result.elapsedMs };
    }
    if (result.timedOut) {
      return { verdict: 'TLE', stdout: result.stdout, elapsedMs: result.elapsedMs };
    }
    if (result.code !== 0) {
      const signal = result.signal ? `signal ${result.signal}` : `exit ${result.code ?? 'unknown'}`;
      const stderrTail = result.stderr.trim().split('\n').slice(-12).join('\n');
      return {
        verdict: 'RE',
        detail: stderrTail ? `${signal}\n${stderrTail}` : signal,
        stdout: result.stdout,
        elapsedMs: result.elapsedMs,
      };
    }
    if (test.expected === undefined) {
      return { verdict: 'NO_OUTPUT', stdout: result.stdout, elapsedMs: result.elapsedMs };
    }
    if (outputsMatch(result.stdout, test.expected)) {
      return { verdict: 'PASS', stdout: result.stdout, elapsedMs: result.elapsedMs };
    }
    return { verdict: 'FAIL', stdout: result.stdout, elapsedMs: result.elapsedMs };
  }

  /**
   * Compiles once and runs every cached sample. Output streams into the right-hand terminal.
   * Returns the tally so callers (and tests) can assert on it.
   */
  async runTests(solution: ActiveSolution, options: { fresh?: boolean } = {}): Promise<{ passed: number; total: number }> {
    if (!this.acquire()) {
      void vscode.window.showWarningMessage('CF Runner is busy (a test batch or submission is in progress).');
      return { passed: 0, total: 0 };
    }
    const pty = this.ensureTerminal();
    if (options.fresh !== false) {
      pty.hardReset();
    }
    pty.writeLine(`CF ${solution.contestId}/${solution.index}  ${path.basename(solution.file)}`, 'bold');
    pty.writeLine(new Date().toLocaleTimeString(), 'grey');
    pty.writeLine();

    try {
      await vscode.window.activeTextEditor?.document.save();

      const tests = await Runner.loadTestCases(solution);
      if (tests.length === 0) {
        pty.writeLine('No testcases found.', 'yellow');
        pty.writeLine(`Expected .in files inside ${problemDir(solution.root, solution.contestId, solution.index)}`, 'grey');
        pty.writeLine('Load the problem again (CF: Open Problem) to fetch the samples.', 'grey');
        return { passed: 0, total: 0 };
      }

      const binary = await this.compile(solution, pty);
      if (!binary) {
        pty.writeLine();
        pty.writeLine('Aborted: fix the compilation errors above.', 'red');
        return { passed: 0, total: tests.length };
      }
      pty.writeLine();

      let passed = 0;
      let totalRuntime = 0;
      for (const test of tests) {
        const result = await this.runSingle(binary, test, solution);
        totalRuntime += result.elapsedMs;
        const name = `Test #${test.name}`;
        const ms = `${result.elapsedMs} ms`;
        const note = test.expected === undefined ? ' output shown, no expected file' : '';

        if (result.verdict === 'PASS') {
          passed += 1;
          pty.write(`${paint('  PASS ', 'green')}  ${name.padEnd(11)} ${paint(ms.padStart(8), 'grey')}${note}\n`);
          continue;
        }

        pty.write(
          `${paint(`  ${result.verdict.padEnd(4)} `, VERDICT_STYLE[result.verdict])}  ${name.padEnd(11)} ${paint(
            ms.padStart(8),
            'grey',
          )}${note}\n`,
        );

        if (result.verdict === 'FAIL' && test.expected !== undefined) {
          const line = firstDiffLine(result.stdout, test.expected);
          const block = [
            ...renderBlock('Expected', test.expected, line, 'green'),
            ...renderBlock('Actual', result.stdout.length > 0 ? result.stdout : '', line, 'red'),
          ];
          for (const rendered of block) {
            pty.write(`  ${rendered}\n`);
          }
          pty.writeLine(`  first difference at line ${line}`, 'grey');
        } else if (result.verdict === 'RE') {
          pty.writeLine(`  ${result.detail ?? 'runtime error'}`, 'magenta');
          if (result.stdout.trim()) {
            for (const rendered of renderBlock('stdout', result.stdout, null, 'grey')) {
              pty.write(`  ${rendered}\n`);
            }
          }
        } else if (result.verdict === 'TLE') {
          pty.writeLine(`  exceeded cfVscode.timeoutMs (${this.config().timeoutMs} ms)`, 'yellow');
        } else if (result.verdict === 'NO_OUTPUT') {
          for (const rendered of renderBlock('Output', result.stdout, null, 'grey')) {
            pty.write(`  ${rendered}\n`);
          }
        }
        pty.writeLine();
      }

      pty.writeLine();
      const failed = tests.length - passed;
      if (failed === 0) {
        pty.writeLine(`  ALL ${tests.length} TESTS PASSED`, 'green');
      } else {
        pty.writeLine(`  ${passed}/${tests.length} PASSED, ${failed} FAILED`, 'red');
      }
      pty.writeLine(`  total runtime ${totalRuntime} ms`, 'grey');
      return { passed, total: tests.length };
    } catch (error) {
      pty.writeLine(`Runner error: ${error instanceof Error ? error.message : String(error)}`, 'red');
      return { passed: 0, total: 0 };
    } finally {
      this.release();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      try {
        subscription.dispose();
      } catch {
        /* already disposed */
      }
    }
    try {
      this.terminal?.dispose();
    } catch {
      /* terminal already gone */
    }
    this.terminal = null;
    this.pty = null;
  }
}

export const __testing = { ANSI, paint, execProcess };
