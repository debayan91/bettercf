import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { CfBrowser } from './cfBrowser';
import { detectChrome, detectCompiler } from './environment';
import { toCfError } from './errors';
import { readConfig, updateSetting } from './config';
import { applyCockpitLayout } from './layout';
import { ActiveSolution, Runner } from './runner';
import {
  ContestKind,
  ContestProblem,
  ProblemRef,
  ProblemStatement,
  Scraper,
  contestDir,
  parseProblemInput,
  problemDir,
  problemUrl,
  solutionPath,
  workspaceRoot,
} from './scraper';
import { Submitter } from './submitter';
import { StatementView } from './webview';

/** Everything the extension knows about the problem currently on screen. */
interface SessionState {
  contestId?: string;
  index?: string;
  kind?: ContestKind;
  contestProblems: ContestProblem[];
}

let disposables: vscode.Disposable[] = [];
let browser: CfBrowser | undefined;
let runner: Runner | undefined;
let scraper: Scraper | undefined;
let statementView: StatementView | undefined;
let submitter: Submitter | undefined;
let output: vscode.OutputChannel | undefined;
let prefetchGeneration = 0;
let problemGeneration = 0;
let retryProblem: (() => Promise<void>) | undefined;
let session: SessionState = { contestProblems: [] };

/* -------------------------------------------------------------------------- */
/* Activation                                                                 */
/* -------------------------------------------------------------------------- */

export function activate(context: vscode.ExtensionContext): void {
  const log = (message: string): void => {
    output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  };
  output = vscode.window.createOutputChannel('Codeforces');
  disposables.push(output);

  browser = new CfBrowser(context.globalStorageUri, log);
  runner = new Runner(readConfig);
  scraper = new Scraper(browser, readConfig, (message) => {
    log(message);
    if (runner) {
      runner.writeLine(message, 'grey');
    }
  });
  statementView = new StatementView({
    extensionUri: context.extensionUri,
    onOpenExternal: (url) => {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    },
    onRequestRefresh: () => { void vscode.commands.executeCommand('cfVscode.refreshProblem'); },
    onRetry: () => { void vscode.commands.executeCommand('cfVscode.retryProblem'); },
    onLogin: () => { void vscode.commands.executeCommand('cfVscode.login'); },
  });
  submitter = new Submitter(browser, readConfig, () => {
    if (!runner) {
      throw new Error('runner is not initialised');
    }
    return runner;
  });

  const register = (command: string, handler: (...args: never[]) => unknown): void => {
    disposables.push(
      vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        try {
          await (handler as (...inner: unknown[]) => unknown)(...args);
        } catch (error) {
          const failure = toCfError(error);
          const message = failure.message;
          log(`Command ${command} failed: ${failure.detail ?? message}`);
          void vscode.window.showErrorMessage(`CF: ${message}`, 'Show Log').then((choice) => {
            if (choice === 'Show Log') {
              output?.show(true);
            }
          });
        }
      }),
    );
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(terminal) Codeforces';
  status.tooltip = 'Open Codeforces command center';
  status.command = 'cfVscode.start';
  status.show();
  disposables.push(status);
  register('cfVscode.start', commandCenter);
  register('cfVscode.doctor', doctor);
  register('cfVscode.refreshProblem', refreshActiveProblem);
  register('cfVscode.retryProblem', async () => { await retryProblem?.(); });
  register('cfVscode.login', login);
  register('cfVscode.refreshSession', validateSession);
  register('cfVscode.loadContest', loadContest);
  register('cfVscode.openProblem', openProblemCommand);
  register('cfVscode.switchProblem', switchProblem);
  register('cfVscode.runTests', runTestsForActiveEditor);
  register('cfVscode.submit', submitActiveEditor);

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const solution = solutionFromPath(document.uri.fsPath);
      if (solution && solution.contestId === session.contestId && solution.index === session.index) {
        log(`Saved ${path.basename(solution.file)}`);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        return;
      }
      const solution = solutionFromPath(editor.document.uri.fsPath);
      if (solution) {
        if (session.contestId !== solution.contestId) { session.kind = undefined; session.contestProblems = []; }
        session.contestId = solution.contestId;
        session.index = solution.index;
      }
    }),
  );

  context.subscriptions.push(...disposables);
  log('Codeforces cockpit ready.');
  if (!context.globalState.get<boolean>('welcomeShown')) {
    void context.globalState.update('welcomeShown', true);
    void vscode.window.showInformationMessage(
      'Codeforces is ready. Open a folder, then use the Codeforces button in the status bar to get started.',
      'Get Started',
    ).then((choice) => { if (choice === 'Get Started') { void vscode.commands.executeCommand('cfVscode.start'); } });
  }
}

export async function deactivate(): Promise<void> {
  for (const disposable of disposables) {
    try {
      disposable.dispose();
    } catch {
      /* best effort */
    }
  }
  disposables = [];
  try {
    statementView?.dispose();
  } catch {
    /* already disposed */
  }
  try {
    runner?.dispose();
  } catch {
    /* already disposed */
  }
  await browser?.dispose().catch(() => undefined);
  output = undefined;
  browser = undefined;
  runner = undefined;
  scraper = undefined;
  statementView = undefined;
  submitter = undefined;
}

/* -------------------------------------------------------------------------- */
/* Path helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Recovers `{contestId, index}` from a `.../{contestId}/{index}.cpp` path. */
function solutionFromPath(filePath: string): ActiveSolution | null {
  const normalised = path.normalize(filePath);
  const match = /([^/\\]+)[/\\]([A-Za-z]\d?)\.cpp$/i.exec(normalised);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const contestId = match[1];
  if (!/^\d+$/.test(contestId)) {
    return null;
  }
  const index = match[2].toUpperCase();
  const root = path.dirname(path.dirname(normalised));
  return { root, contestId, index, file: normalised };
}

/** Resolves the active solution from the editor, the workspace tree, or the last session. */
async function resolveActiveSolution(): Promise<ActiveSolution | null> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const fromEditor = solutionFromPath(editor.document.uri.fsPath);
    if (fromEditor) {
      if (session.contestId !== fromEditor.contestId) { session.kind = undefined; session.contestProblems = []; }
      session.contestId = fromEditor.contestId;
      session.index = fromEditor.index;
      return fromEditor;
    }
  }
  if (session.contestId && session.index) {
    const root = workspaceRoot();
    const file = solutionPath(root, session.contestId, session.index);
    if (fs.existsSync(file)) {
      return { root, contestId: session.contestId, index: session.index, file };
    }
  }
  const visible = vscode.window.visibleTextEditors
    .map((item) => solutionFromPath(item.document.uri.fsPath))
    .find((item): item is ActiveSolution => item !== null);
  return visible ?? null;
}

function requireServices(): { browser: CfBrowser; scraper: Scraper; runner: Runner; view: StatementView; submitter: Submitter } {
  if (!browser || !scraper || !runner || !statementView || !submitter) {
    throw new Error('The extension is still starting up. Try again in a moment.');
  }
  return { browser, scraper, runner, view: statementView, submitter };
}

/* -------------------------------------------------------------------------- */
/* Template handling                                                          */
/* -------------------------------------------------------------------------- */

/** Copies the user's C++ template verbatim, or writes a minimal fallback. */
async function createSolutionFromTemplate(target: string): Promise<{ created: boolean; usedTemplate: boolean }> {
  if (fs.existsSync(target)) {
    return { created: false, usedTemplate: false };
  }
  const cfg = readConfig();
  await fsp.mkdir(path.dirname(target), { recursive: true });

  if (cfg.templatePath) {
    let contents: string | undefined;
    try { contents = await fsp.readFile(cfg.templatePath, 'utf8'); }
    catch (error) {
      void vscode.window.showWarningMessage(`Could not read template ${cfg.templatePath}: ${error instanceof Error ? error.message : String(error)}. Using a minimal skeleton.`);
    }
    if (contents !== undefined) {
      try { await fsp.writeFile(target, contents, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { return { created: false, usedTemplate: false }; } throw error; }
      return { created: true, usedTemplate: true };
    }
  }
  try { await fsp.writeFile(target, defaultTemplate(), { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { return { created: false, usedTemplate: false }; } throw error; }
  return { created: true, usedTemplate: false };
}

function defaultTemplate(): string {
  return [
    '#include <bits/stdc++.h>',
    'using namespace std;',
    '',
    'int main() {',
    '    ios::sync_with_stdio(false);',
    '    cin.tie(nullptr);',
    '',
    '    return 0;',
    '}',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Problem opening                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Renders the left column, opens the middle column, shows the right column and finally pins
 * the 30 / 45 / 25 layout.
 */
async function presentProblem(root: string, statement: ProblemStatement): Promise<void> {
  const { runner: testRunner, view } = requireServices();
  const ref = statement.ref;
  const file = solutionPath(root, ref.contestId, ref.index);

  view.show(statement, vscode.ViewColumn.One);

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Two,
    preserveFocus: true,
    preview: false,
  });

  const pty = testRunner.show();
  if (!testRunner.hasContent) {
    pty.renderStatus({ title: `${ref.contestId}/${ref.index}`, subtitle: 'Your local test runner is ready.',
      hints: [{ key: 'Ctrl/Cmd+Shift+R', label: 'Run sample tests' }, { key: 'Ctrl/Cmd+Shift+S', label: 'Submit solution' }] });
  }
  await applyCockpitLayout();

  // Keep the user's caret in the code, not in the statement/terminal. `show()` moves focus
  // and reveals the requested column without touching the layout applied above.
  editor.show();

  session.contestId = ref.contestId;
  session.index = ref.index;
  session.kind = ref.kind;
  output?.appendLine(`Opened ${problemUrl(ref)}`);
}

/** Opens (or re-uses) a problem: cache-first, then scrape, always guaranteeing the `.cpp`. */
async function openProblem(root: string, ref: ProblemRef, options: { force?: boolean } = {}): Promise<void> {
  const { scraper: problemScraper, view } = requireServices();
  const generation = ++problemGeneration;
  const file = solutionPath(root, ref.contestId, ref.index);
  const created = await createSolutionFromTemplate(file);

  session.contestId = ref.contestId;
  session.index = ref.index;
  session.kind = ref.kind;

  const cached = !options.force && fs.existsSync(path.join(problemDir(root, ref.contestId, ref.index), 'statement.html'));
  if (!cached) {
    view.showLoading(`Fetching ${ref.contestId}/${ref.index} from Codeforces...`, vscode.ViewColumn.One);
  }

  let statement: ProblemStatement;
  try {
    statement = await problemScraper.getStatement(root, ref, { force: options.force });
  } catch (error) {
    if (generation !== problemGeneration) { return; }
    retryProblem = () => openProblem(root, ref, options);
    view.showError(error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (generation !== problemGeneration) { return; }
  if (created.created && !created.usedTemplate) {
    void vscode.window.showInformationMessage(
      `Created ${path.basename(file)}. Point cfVscode.templatePath at your own template to use it for new files.`,
    );
  }
  retryProblem = undefined;
  await presentProblem(root, statement);
}

async function refreshActiveProblem(): Promise<void> {
  const solution = await resolveActiveSolution();
  if (!solution) {
    void vscode.window.showWarningMessage('No active solution file to refresh.');
    return;
  }
  // `force` re-scrapes the statement, but persistStatement() only writes sample files that
  // are missing, so local edits to `*.in` / `*.out` survive a refresh.
  await openProblem(
    solution.root,
    { contestId: solution.contestId, index: solution.index, kind: session.kind ?? 'contest' },
    { force: true },
  );
}

/* -------------------------------------------------------------------------- */
/* Command: login                                                             */
/* -------------------------------------------------------------------------- */

async function login(): Promise<void> {
  const { browser: cfBrowser } = requireServices();
  const terminal = ensureTerminalShown();
  terminal.writeLine('Opening Chrome. Sign in; this window closes automatically once login is detected.', 'grey');
  const result = await cfBrowser.login(readConfig(), (message) => terminal.writeLine(message, 'grey'));
  if (result.signedIn) {
    if (result.handle) { await updateSetting('handle', result.handle); }
    terminal.writeLine(result.message, 'green');
    void vscode.window.showInformationMessage(`Codeforces: ${result.message}`);
  } else {
    terminal.writeLine(result.message, 'yellow');
    void vscode.window.showWarningMessage(`Codeforces: ${result.message}`);
  }
}

async function validateSession(): Promise<void> {
  const result = await requireServices().browser.validateSession(readConfig());
  const terminal = ensureTerminalShown();
  terminal.writeLine(result.message, result.signedIn ? 'green' : 'yellow');
  if (result.detail) { output?.appendLine(result.detail); }
  if (result.signedIn && result.handle) { await updateSetting('handle', result.handle); }
  if (!result.signedIn) { void vscode.window.showWarningMessage(`Codeforces: ${result.message}`); }
}

async function commandCenter(): Promise<void> {
  const items = [
    { label: '$(account) Log in to Codeforces', description: 'Sign in once in Chrome', command: 'cfVscode.login' },
    { label: '$(trophy) Load a contest', description: 'Enter a contest ID', command: 'cfVscode.loadContest' },
    { label: '$(book) Open a problem', description: 'Enter a URL or contest/index', command: 'cfVscode.openProblem' },
    { label: '$(list-selection) Switch problem', description: 'Choose a problem in this contest', command: 'cfVscode.switchProblem' },
    { label: '$(play) Run samples', description: 'Compile and test your solution', command: 'cfVscode.runTests' },
    { label: '$(cloud-upload) Submit', description: 'Submit your solution to Codeforces', command: 'cfVscode.submit' },
    { label: '$(tools) Check setup', description: 'Check Chrome and C++ compiler', command: 'cfVscode.doctor' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'Codeforces', placeHolder: 'What would you like to do?' });
  if (picked) { await vscode.commands.executeCommand(picked.command); }
}

async function doctor(): Promise<void> {
  const cfg = readConfig();
  const [chrome, compiler] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking your Codeforces setup' },
    () => Promise.all([detectChrome(cfg.chromePath), detectCompiler(cfg.compilerCommand)]),
  );
  const lines = [
    chrome ? `Browser: ${chrome.path}` : 'Browser: not found. Install Chrome or set cfVscode.chromePath.',
    compiler ? `C++ compiler found: ${compiler.version}. Current command: ${cfg.compilerCommand}` : 'C++ compiler: not found. Install g++ and add it to PATH.',
    vscode.workspace.workspaceFolders?.length ? 'Workspace: open' : 'Workspace: open a folder to save your solutions.',
    cfg.handle ? `Codeforces handle: ${cfg.handle}` : 'Codeforces handle: sign in to detect it.',
  ];
  output?.appendLine(`Setup check:\n${lines.join('\n')}`);
  const choice = await vscode.window.showInformationMessage(lines.join('  |  '), 'Open Settings', 'Show Log');
  if (choice === 'Open Settings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'cfVscode'); }
  if (choice === 'Show Log') { output?.show(); }
}

/* -------------------------------------------------------------------------- */
/* Command: load contest                                                      */
/* -------------------------------------------------------------------------- */

async function loadContest(): Promise<void> {
  const { scraper: problemScraper, runner: testRunner } = requireServices();
  const root = workspaceRoot();

  const input = await vscode.window.showInputBox({
    title: 'CF: Load Contest',
    prompt: 'Contest id (e.g. 2045) or a gym id',
    placeHolder: '2045',
    validateInput: (value) => (/^\d{2,}$/.test(value.trim()) ? undefined : 'Contest ids are numeric.'),
  });
  if (!input) {
    return;
  }
  const contestId = input.trim();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `CF: loading contest ${contestId}`, cancellable: true },
    async (progress, token) => {
      // Gym ids are five digits or more; try the regular endpoint first and fall back later.
      let kind: ContestKind = 'contest';
      let problems: ContestProblem[];
      try {
        problems = await problemScraper.fetchProblemList(root, contestId, 'contest');
      } catch (error) {
        progress.report({ message: 'retrying as gym...' });
        kind = 'gym';
        try {
          problems = await problemScraper.fetchProblemList(root, contestId, 'gym');
        } catch {
          throw error;
        }
      }

      const contestRoot = contestDir(root, contestId);
      await fsp.mkdir(contestRoot, { recursive: true });

      let created = 0;
      for (const problem of problems) {
        const outcome = await createSolutionFromTemplate(solutionPath(root, contestId, problem.index));
        if (outcome.created) {
          created += 1;
        }
      }
      session.contestProblems = problems.map((problem) => ({ ...problem, kind }));
      testRunner.show();
      testRunner.writeLine(
        `Contest ${contestId}: ${problems.length} problems (${created} new files) in ${contestRoot}`,
        'bold',
      );

      const first = problems[0];
      if (!first) {
        throw new Error(`Contest ${contestId} has no problems.`);
      }

      progress.report({ message: `opening ${first.index}...` });
      await openProblem(root, { contestId, index: first.index, kind, title: first.name });

      // Everything else is warmed up one at a time so switching is instantaneous.
      const generation = ++prefetchGeneration;
      const remaining = problems
        .filter((problem) => problem.index !== first.index)
        .map((problem) => ({ contestId, index: problem.index, kind, title: problem.name }));
      void problemScraper
        .prefetchStatements(root, remaining, () => token.isCancellationRequested || generation !== prefetchGeneration, (ref) => {
          output?.appendLine(`Prefetched ${ref.contestId}/${ref.index}`);
        })
        .then(() => {
          if (generation === prefetchGeneration) {
            output?.appendLine(`Contest ${contestId}: prefetch complete.`);
          }
        });
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Command: open problem                                                      */
/* -------------------------------------------------------------------------- */

async function openProblemCommand(): Promise<void> {
  const root = workspaceRoot();
  const guessed = guessProblemFromActiveFile();
  const input = await vscode.window.showInputBox({
    title: 'CF: Open Problem',
    prompt: 'URL, or contestId/index',
    placeHolder: '2045/C',
    value: guessed ?? '',
    validateInput: (value) => (parseProblemInput(value) ? undefined : 'Use a Codeforces URL or contestId/index.'),
  });
  if (!input) {
    return;
  }
  const ref = parseProblemInput(input);
  if (!ref) {
    throw new Error(`Could not parse "${input}". Expected 2045/C or a codeforces.com URL.`);
  }
  await determineKind(root, ref);
  await openProblem(root, ref);
}

function guessProblemFromActiveFile(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const solution = solutionFromPath(editor.document.uri.fsPath);
  return solution ? `${solution.contestId}/${solution.index}` : undefined;
}

/** Distinguishes gym from contest ids once, and remembers it. */
async function determineKind(root: string, ref: ProblemRef): Promise<void> {
  if (ref.kind === 'gym') {
    return;
  }
  const { scraper: problemScraper } = requireServices();
  const known = await problemScraper.readCachedProblemList(root, ref.contestId);
  const cachedKind = session.contestProblems.find((problem) => problem.contestId === ref.contestId)?.kind;
  if (cachedKind) {
    ref.kind = cachedKind;
    return;
  }
  if (known && known[0]?.kind) {
    ref.kind = known[0].kind;
  }
}

/* -------------------------------------------------------------------------- */
/* Command: switch problem                                                    */
/* -------------------------------------------------------------------------- */

async function switchProblem(): Promise<void> {
  const { scraper: problemScraper } = requireServices();
  const root = workspaceRoot();
  const solution = await resolveActiveSolution();
  const draftContest = solution?.contestId ?? session.contestId;
  if (!draftContest) {
    throw new Error('Open a problem first (CF: Load Contest or CF: Open Problem).');
  }
  const contestId = draftContest;
  let problems = (await problemScraper.readCachedProblemList(root, contestId)) ?? session.contestProblems;
  if (problems.length === 0) {
    problems = await problemScraper.fetchProblemList(root, contestId, session.kind ?? 'contest');
  }
  session.contestProblems = problems;

  const items: Array<vscode.QuickPickItem & { index: string }> = problems.map((problem) => {
    const cached = fs.existsSync(path.join(problemDir(root, contestId, problem.index), 'statement.html'));
    const solvedMarker = cached ? 'cached' : 'not fetched';
    return {
      label: `${problem.index}. ${problem.name}`,
      description: [problem.rating ? `rating ${problem.rating}` : '', solvedMarker].filter(Boolean).join('  ·  '),
      detail: problem.tags.length > 0 ? problem.tags.join(', ') : undefined,
      index: problem.index,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `CF: Switch Problem — contest ${contestId}`,
    placeHolder: 'Problem to open',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }
  await openProblem(root, {
    contestId,
    index: picked.index,
    kind: session.kind ?? problems[0]?.kind ?? 'contest',
    title: picked.label,
  });
}

/* -------------------------------------------------------------------------- */
/* Command: run tests                                                         */
/* -------------------------------------------------------------------------- */

async function runTestsForActiveEditor(): Promise<void> {
  const { runner: testRunner } = requireServices();
  const solution = await resolveActiveSolution();
  if (!solution) {
    void vscode.window.showWarningMessage(
      'CF: no solution file detected. Open a problem first (CF: Load Contest / CF: Open Problem).',
    );
    return;
  }
  if (!(await saveSolution(solution.file))) { return; }
  // Re-assert the layout in case the user dragged panels around.
  testRunner.show();
  await applyCockpitLayout();
  await testRunner.runTests(solution);
}

/* -------------------------------------------------------------------------- */
/* Command: submit                                                            */
/* -------------------------------------------------------------------------- */

async function submitActiveEditor(): Promise<void> {
  const { submitter: cfSubmitter } = requireServices();
  const solution = await resolveActiveSolution();
  if (!solution) {
    void vscode.window.showWarningMessage('CF: no solution file detected. Open a problem first.');
    return;
  }

  if (!(await saveSolution(solution.file))) { return; }

  const ref: ProblemRef = { contestId: solution.contestId, index: solution.index, kind: session.kind ?? 'contest' };
  await determineKind(solution.root, ref);
  const problem = session.contestProblems.find((item) => item.contestId === solution.contestId && item.index === solution.index);
  await cfSubmitter.submit({
    kind: ref.kind,
    contestId: solution.contestId,
    index: solution.index,
    file: solution.file,
    problemName: problem?.name,
  });
}

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

async function saveSolution(file: string): Promise<boolean> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  if (!document.isDirty || await document.save()) { return true; }
  void vscode.window.showErrorMessage('Could not save your solution. Fix the save error and try again.');
  return false;
}

function ensureTerminalShown(): Runner {
  const testRunner = requireServices().runner;
  testRunner.show();
  return testRunner;
}
