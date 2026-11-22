import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { CfBrowser, SessionValidation } from './cfBrowser';
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
    onRequestRefresh: () => {
      void refreshActiveProblem();
    },
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
          const message = error instanceof Error ? error.message : String(error);
          log(`Command ${command} failed: ${message}`);
          void vscode.window.showErrorMessage(`CF: ${message}`, 'Show Log').then((choice) => {
            if (choice === 'Show Log') {
              output?.show(true);
            }
          });
        }
      }),
    );
  };

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
        session.contestId = solution.contestId;
        session.index = solution.index;
      }
    }),
  );

  context.subscriptions.push(...disposables);
  log('Codeforces cockpit ready.');
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
    try {
      const contents = await fsp.readFile(cfg.templatePath, 'utf8');
      await fsp.writeFile(target, contents, 'utf8');
      return { created: true, usedTemplate: true };
    } catch {
      void vscode.window.showWarningMessage(
        `Could not read the template at ${cfg.templatePath}. Using a minimal skeleton instead.`,
      );
    }
  }
  await fsp.writeFile(target, defaultTemplate(), 'utf8');
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

  testRunner.show();
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
  const file = solutionPath(root, ref.contestId, ref.index);
  const created = await createSolutionFromTemplate(file);

  session.contestId = ref.contestId;
  session.index = ref.index;
  session.kind = ref.kind;

  const cached = !options.force && fs.existsSync(path.join(problemDir(root, ref.contestId, ref.index), 'statement.html'));
  if (!cached) {
    view.showLoading(`Fetching ${ref.contestId}/${ref.index} from Codeforces...`, vscode.ViewColumn.One);
  }

  const statement = await problemScraper.getStatement(root, ref, { force: options.force });
  if (created.created && !created.usedTemplate) {
    void vscode.window.showInformationMessage(
      `Created ${path.basename(file)}. Point cfVscode.templatePath at your own template to use it for new files.`,
    );
  }
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
  const cfg = await resolveChromePath();
  const terminal = ensureTerminalShown();
  terminal.writeLine('Opening Codeforces in Chrome. Log in, then close the window.', 'grey');
  await cfBrowser.openForLogin(cfg, 'https://codeforces.com/enter');
  terminal.writeLine('Chrome closed: cookies saved.', 'grey');

  const validation = await cfBrowser
    .validateSession(readConfig())
    .catch((): SessionValidation => ({ signedIn: false }));
  if (validation.signedIn) {
    terminal.writeLine(`Session valid${validation.handle ? ` as ${validation.handle}` : ''}.`, 'green');
    const cfgNow = readConfig();
    if (!cfgNow.handle && validation.handle) {
      await updateSetting('handle', validation.handle);
      terminal.writeLine(`Saved handle "${validation.handle}" to cfVscode.handle.`, 'grey');
    }
    void vscode.window.showInformationMessage(
      `Codeforces session ready${validation.handle ? ` as ${validation.handle}` : ''}.`,
    );
  } else {
    terminal.writeLine('No logged-in session detected. Run the login command again if needed.', 'yellow');
    void vscode.window.showWarningMessage('Codeforces did not report a signed-in session.');
  }
}

async function promptChromePath(): Promise<void> {
  const picked = await vscode.window.showInputBox({
    title: 'Path to Google Chrome',
    prompt: 'Absolute path to your Chrome executable',
    value: readConfig().chromePath,
    validateInput: (value) => {
      if (!value.trim()) {
        return 'A path is required.';
      }
      try {
        fs.accessSync(value.trim(), fs.constants.X_OK);
        return undefined;
      } catch {
        return 'That file does not exist or is not executable.';
      }
    },
  });
  if (picked) {
    await updateSetting('chromePath', picked.trim());
  }
}

async function validateSession(): Promise<void> {
  const { browser: cfBrowser } = requireServices();
  const terminal = ensureTerminalShown();
  terminal.writeLine('Checking the saved Codeforces session...', 'grey');
  const defaultCfg = await resolveChromePath();
  const result = await cfBrowser.validateSession(defaultCfg);
  if (result.signedIn) {
    terminal.writeLine(`Session valid${result.handle ? ` as ${result.handle}` : ''}.`, 'green');
    if (!readConfig().handle && result.handle) {
      await updateSetting('handle', result.handle);
    }
  } else {
    terminal.writeLine('Session missing or expired. Run "CF: Login / Refresh Session".', 'yellow');
  }
}

/** Reads the config, prompting once for a usable Chrome path when it is missing. */
async function resolveChromePath(): Promise<ReturnType<typeof readConfig>> {
  let cfg = readConfig();
  if (!cfg.chromePath || !fs.existsSync(cfg.chromePath)) {
    await promptChromePath();
    cfg = readConfig();
  }
  return cfg;
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

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.fsPath === solution.file) {
    await editor.document.save();
  } else {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(solution.file));
    if (document.isDirty) {
      await document.save();
    }
  }

  const problem = session.contestProblems.find((item) => item.index === solution.index);
  await cfSubmitter.submit({
    kind: session.kind ?? 'contest',
    contestId: solution.contestId,
    index: solution.index,
    file: solution.file,
    problemName: problem?.name,
  });
}

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

function ensureTerminalShown(): Runner {
  const testRunner = requireServices().runner;
  testRunner.show();
  return testRunner;
}
