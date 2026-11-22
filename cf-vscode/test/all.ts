/* eslint-disable no-console */
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  decodeEntities,
  htmlToText,
  parseProblemInput,
  parseProblemPage,
  problemDir,
  Scraper,
  parseSamples,
  rewriteUrls,
} from '../src/scraper';
import {
  RunnerPseudoTerminal,
  firstDiffLine,
  normaliseOutput,
  outputsMatch,
  Runner,
  shellQuote,
  splitCommand,
} from '../src/runner';
import { applyCockpitLayout } from '../src/layout';
import { readConfig } from '../src/config';
import { CfBrowser } from '../src/cfBrowser';
import { Submitter } from '../src/submitter';
import * as vscode from 'vscode';
import { runCapture } from '../src/environment';
import { buildErrorHtml, buildLoadingHtml, buildStatementHtml, KATEX_RUNNER } from '../src/webview';
import { JSDOM, VirtualConsole } from 'jsdom';
import katex from 'katex';

/* -------------------------------------------------------------------------- */
/* Tiny test harness                                                          */
/* -------------------------------------------------------------------------- */

let failures = 0;
let passes = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passes += 1;
      console.log(`  ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* Fixtures mirroring Codeforces markup                                       */
/* -------------------------------------------------------------------------- */

const SAMPLE_TEST_HTML = `
<div class="sample-tests">
  <div class="section-title">Examples</div>
  <div class="sample-test">
    <div class="input">
      <div class="title">Input<div class="input-output-copier" data-clipboard-target="#id001">Copy</div></div>
      <pre><div class="test-example-line test-example-line-odd">4 5</div><div class="test-example-line test-example-line-even">1 2 3 4</div></pre>
    </div>
    <div class="output">
      <div class="title">Output<div class="input-output-copier" data-clipboard-target="#id002">Copy</div></div>
      <pre><div class="test-example-line test-example-line-odd">10</div></pre>
    </div>
  </div>
  <div class="sample-test">
    <div class="input">
      <div class="title">Input</div>
      <pre>7
1 1 1 1 1 1 1
</pre>
    </div>
    <div class="output">
      <div class="title">Output</div>
      <pre>3</pre>
    </div>
  </div>
</div>`;

const PROBLEM_PAGE_HTML = `<!DOCTYPE html><html><head><title>Problem 4A</title></head><body>
<div class="problemindexholder" problemindex="A">
<div class="ttypography">
  <div class="problem-statement">
    <div class="header">
      <div class="title">A. Watermelon</div>
      <div class="time-limit">time limit per test<span class="tex-font-style-it">1 second</span></div>
      <div class="memory-limit">memory limit per test<span class="tex-font-style-it">256 megabytes</span></div>
      <div class="input-file">input<span class="tex-font-style-bf">standard input</span></div>
    </div>
    <div><p>One hot summer day Pete and his friend Billy decided to buy a watermelon.</p>
    <p>They chose the biggest one, weighing $$$w$$$ kilos. The splits are $$$1 \\le w \\le 100$$$.</p>
    <p>$$$$\\frac{a}{b}$$$$</p>
    <p>$$$$$$\\sum_{i=1}^{n} a_i$$$$$$</p>
    <p>A price of $$$\\$5$$$ and a plain $5 note are different.</p>
    <p><img src="/predownloaded/aa/bb/watermelon.png" alt="diagram"/></p>
    <p><img src="//espresso.codeforces.com/abc.png"/></p>
    </div>
    <div class="input-specification"><div class="section-title">Input</div>
      <p>The first line contains $$$w$$$.</p></div>
    <div class="output-specification"><div class="section-title">Output</div>
      <p>Print YES if divisible into two even parts.</p></div>
    ${SAMPLE_TEST_HTML}
    <div class="note"><div class="section-title">Note</div><p>$$$2$$$ is not possible.</p></div>
    <script>alert('nope')</script>
  </div>
</div></div>
</body></html>`;

/* -------------------------------------------------------------------------- */
/* Suites                                                                     */
/* -------------------------------------------------------------------------- */

async function run(): Promise<void> {
  section('scraper: entities and plain text');
  await check('decodes named and numeric entities', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42; &ndash;'), 'a & b <c> A B \u2013');
    assert.equal(decodeEntities('&unknownent;'), '&unknownent;');
  });
  await check('htmlToText keeps line breaks for <br> and </p>', () => {
    assert.equal(htmlToText('<p>a</p><p>b<br/>c</p>'), 'a\nb\nc\n');
  });

  section('scraper: sample extraction');
  await check('parses both samples, not the copy-button divs', () => {
    const samples = parseSamples(SAMPLE_TEST_HTML);
    assert.equal(samples.length, 2, `expected 2 samples, got ${samples.length}`);
    assert.equal(samples[0]?.input, '4 5\n1 2 3 4\n');
    assert.equal(samples[0]?.expected, '10\n');
  });
  await check('falls back to pre innerText when test-example-line divs are absent', () => {
    const samples = parseSamples(SAMPLE_TEST_HTML);
    assert.equal(samples[1]?.input, '7\n1 1 1 1 1 1 1\n');
    assert.equal(samples[1]?.expected, '3\n');
  });

  section('scraper: statement parsing');
  await check('extracts title and normalised limits', () => {
    const statement = parseProblemPage(PROBLEM_PAGE_HTML, { contestId: '4', index: 'A', kind: 'contest' }, 'x');
    assert.equal(statement.title, 'A. Watermelon');
    assert.equal(statement.timeLimit, '1 second');
    assert.equal(statement.memoryLimit, '256 megabytes');
  });
  await check('keeps Codeforces $$$ delimiters and strips scripts', () => {
    const statement = parseProblemPage(PROBLEM_PAGE_HTML, { contestId: '4', index: 'A', kind: 'contest' }, 'x');
    assert.ok(statement.bodyHtml.includes('$$$w$$$'), 'inline delimiters must survive');
    assert.ok(!statement.bodyHtml.includes('<script'), 'scripts must be stripped');
    assert.ok(!statement.bodyHtml.includes('alert('), 'inline js must be stripped');
    assert.ok(!statement.bodyHtml.includes('problem-statement'), 'the wrapper div is removed');
  });
  await check('rewrites relative and protocol-relative asset urls', () => {
    const html = rewriteUrls('<img src="/predownloaded/a.png"><img src="//espresso.codeforces.com/b.png"><a href="#x">');
    assert.ok(html.includes('src="https://codeforces.com/predownloaded/a.png"'), html);
    assert.ok(html.includes('src="https://espresso.codeforces.com/b.png"'), html);
    assert.ok(html.includes('href="#x"'), 'fragments are untouched');
  });
  await check('rejects pages without a statement', () => {
    assert.throws(() => parseProblemPage('<html><title>Just a moment</title></html>', { contestId: '1', index: 'A', kind: 'contest' }, 'x'), /did not contain a statement/);
  });

  section('scraper: input parsing');
  await check('accepts short and URL forms', () => {
    assert.deepEqual(parseProblemInput('2045/C'), { contestId: '2045', index: 'C', kind: 'contest' });
    assert.deepEqual(parseProblemInput('2045 c'), { contestId: '2045', index: 'C', kind: 'contest' });
    assert.deepEqual(parseProblemInput('https://codeforces.com/contest/2045/problem/C'), {
      contestId: '2045',
      index: 'C',
      kind: 'contest',
    });
    assert.deepEqual(parseProblemInput('https://codeforces.com/gym/105123/problem/B'), {
      contestId: '105123',
      index: 'B',
      kind: 'gym',
    });
    assert.deepEqual(parseProblemInput('https://codeforces.com/problemset/problem/4/A'), {
      contestId: '4',
      index: 'A',
      kind: 'contest',
    });
    assert.equal(parseProblemInput('nonsense'), null);
  });

  section('runner: output comparison');
  await check('ignores trailing whitespace and trailing newlines', () => {
    assert.ok(outputsMatch('1 2  \n3\n\n', '1 2\n3'));
    assert.ok(!outputsMatch('1 2\n4', '1 2\n3'));
    assert.equal(normaliseOutput('a \r\nb\t\r\n'), 'a\nb');
    assert.equal(firstDiffLine('1\n2\n3', '1\nX\n3'), 2);
    assert.equal(firstDiffLine('1\n2', '1\n2\n3'), 3);
  });

  section('runner: command handling');
  await check('splits compiler commands respecting quotes', () => {
    assert.deepEqual(splitCommand('g++ -std=gnu++20 -O2 -Wall -Wextra'), [
      'g++',
      '-std=gnu++20',
      '-O2',
      '-Wall',
      '-Wextra',
    ]);
    assert.deepEqual(splitCommand(`cc -DNAME="a b" -I'/opt/my include' x.cpp`), [
      'cc',
      '-DNAME=a b',
      '-I/opt/my include',
      'x.cpp',
    ]);
  });
  await check('quotes shell arguments', () => {
    assert.equal(shellQuote('/tmp/a b/sol'), `'/tmp/a b/sol'`);
    assert.equal(shellQuote('/tmp/sol'), '/tmp/sol');
  });

  section('layout: 30 / 45 / 25');
  await check('issues setEditorLayout with the required ratios', async () => {
    await applyCockpitLayout();
    const call = (globalThis as Record<string, unknown>).__lastCommand as {
      command: string;
      args: unknown[];
    };
    assert.equal(call.command, 'vscode.setEditorLayout');
    const payload = call.args[0] as { groups: Array<{ size: number }> };
    const sizes = payload.groups.map((group) => group.size);
    assert.deepEqual(sizes, [0.3, 0.45, 0.25]);
  });

  section('config: defaults');
  await check('applies the documented defaults', () => {
    const cfg = readConfig();
    assert.equal(cfg.compilerCommand, 'g++ -std=gnu++20 -O2 -Wall -Wextra');
    assert.equal(cfg.cfCompilerId, '89');
    assert.equal(cfg.timeoutMs, 3000);
    assert.equal(cfg.chromePath, '');
  });

  section('scraper: statement cache round-trip');
  const cacheRoot = path.join(tmpdir(), `cf-vscode-cache-${process.pid}`);
  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(cacheRoot, { recursive: true });

  // A scraper whose browser can never launch: every cache hit must avoid it entirely.
  const offlineBrowser = {
    run: async () => {
      throw new Error('the browser must not be used when the cache is warm');
    },
  } as unknown as CfBrowser;
  const offlineScraper = new Scraper(offlineBrowser, readConfig, () => undefined);
  const cachedStatement = parseProblemPage(
    PROBLEM_PAGE_HTML,
    { contestId: '4', index: 'A', kind: 'contest' },
    'https://codeforces.com/contest/4/problem/A',
  );

  const persist = (scraper: Scraper, root: string): Promise<void> =>
    (
      scraper as unknown as {
        persistStatement(root: string, statement: typeof cachedStatement): Promise<void>;
      }
    ).persistStatement(root, cachedStatement);

  await check('writes statement.html, meta.json and numbered samples', async () => {
    await persist(offlineScraper, cacheRoot);
    const dir = problemDir(cacheRoot, '4', 'A');
    assert.ok(readFileSync(path.join(dir, 'statement.html'), 'utf8').includes('$$$w$$$'));
    const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { title: string; samples: unknown[] };
    assert.equal(meta.title, 'A. Watermelon');
    assert.equal(meta.samples.length, 2);
    assert.equal(readFileSync(path.join(dir, '1.in'), 'utf8'), '4 5\n1 2 3 4\n');
    assert.equal(readFileSync(path.join(dir, '1.out'), 'utf8'), '10\n');
    assert.equal(readFileSync(path.join(dir, '2.in'), 'utf8'), '7\n1 1 1 1 1 1 1\n');
    assert.equal(readFileSync(path.join(dir, '2.out'), 'utf8'), '3\n');
  });

  await check('cache hit needs no network and restores deleted sample files', async () => {
    const dir = problemDir(cacheRoot, '4', 'A');
    rmSync(path.join(dir, '1.in'));
    rmSync(path.join(dir, '2.out'));
    const statement = await offlineScraper.getStatement(cacheRoot, { contestId: '4', index: 'A', kind: 'contest' });
    assert.equal(statement.title, 'A. Watermelon');
    assert.equal(statement.samples.length, 2);
    assert.equal(readFileSync(path.join(dir, '1.in'), 'utf8'), '4 5\n1 2 3 4\n');
    assert.equal(readFileSync(path.join(dir, '2.out'), 'utf8'), '3\n');
  });

  await check('re-persisting never overwrites edits to local sample files', async () => {
    const dir = problemDir(cacheRoot, '4', 'A');
    writeFileSync(path.join(dir, '1.in'), '99 1\n');
    await persist(offlineScraper, cacheRoot);
    assert.equal(readFileSync(path.join(dir, '1.in'), 'utf8'), '99 1\n');
  });

  await check('cached statement feeds the runner end to end', async () => {
    const dir = problemDir(cacheRoot, '4', 'A');
    rmSync(path.join(dir, '1.in'));
    writeFileSync(
      path.join(cacheRoot, '4', 'A.cpp'),
      '#include <iostream>\nint main(){ long long a; if(!(std::cin>>a)) return 0; std::cout << a << "\\n"; }\n',
    );
    // The echo program prints the first token: sample 1 ("4 5" -> 10) must fail. Editing
    // 2.out locally to 7 proves the runner honours on-disk expectations over the cache.
    writeFileSync(path.join(dir, '2.out'), '7\n');
    await offlineScraper.getStatement(cacheRoot, { contestId: '4', index: 'A', kind: 'contest' });
    const runner = new Runner(readConfig);
    const result = await runner.runTests({ root: cacheRoot, contestId: '4', index: 'A', file: path.join(cacheRoot, '4', 'A.cpp') });
    runner.dispose();
    assert.equal(result.total, 2);
    assert.equal(result.passed, 1, 'the locally edited expectation must be used');
  });

  rmSync(cacheRoot, { recursive: true, force: true });

  section('browser: login and challenge handling');
  await check('login validates the visible session and never starts a headless validation', async () => {
    const browser = new CfBrowser(vscode.Uri.file('/tmp/cf-test-profile'), () => undefined);
    const modes: string[] = [];
    let closed = 0;
    const page = {
      on: () => undefined, goto: async () => undefined, isClosed: () => false,
      title: async () => 'Codeforces', url: () => 'https://codeforces.com/',
      locator: (selector: string) => ({ first() { return this; },
        count: async () => selector.includes('/logout') || selector.includes('/profile/') ? 1 : 0,
        getAttribute: async () => '/profile/tester' }),
    };
    const context = { pages: () => [page], newPage: async () => page };
    const internal = browser as unknown as { ensure: (mode: string) => Promise<unknown>; closeContext: () => Promise<void> };
    internal.ensure = async (mode) => { modes.push(mode); return context; };
    internal.closeContext = async () => { closed++; };
    const result = await browser.login(readConfig(), () => undefined);
    assert.equal(result.signedIn, true);
    assert.equal(result.handle, 'tester');
    assert.deepEqual(modes, ['headed']);
    assert.ok(closed >= 2);
  });

  await check('login reports closed windows and navigation failures without swallowing them', async () => {
    const browser = new CfBrowser(vscode.Uri.file('/tmp/cf-test-profile'), () => undefined);
    let closed = 0;
    const page = { on: () => undefined, goto: async () => undefined };
    const internal = browser as unknown as { ensure: () => Promise<unknown>; closeContext: () => Promise<void> };
    internal.ensure = async () => ({ pages: () => [page], newPage: async () => page });
    // Simulate the user closing the window after navigation.
    let calls = 0;
    internal.ensure = async () => ({ pages: () => ++calls === 1 ? [page] : [], newPage: async () => page });
    internal.closeContext = async () => { closed++; };
    const result = await browser.login(readConfig(), () => undefined);
    assert.equal(result.state, 'signed-out');
    assert.match(result.message, /closed/);
    page.goto = async () => { throw new Error('network offline'); };
    calls = 0;
    await assert.rejects(browser.login(readConfig(), () => undefined), /Could not open codeforces/);
    assert.ok(closed >= 4, 'context should close even on navigation errors');
  });

  await check('headless Cloudflare challenge is not reported as a signed-out session', async () => {
    const browser = new CfBrowser(vscode.Uri.file('/tmp/cf-test-profile'), () => undefined);
    const page = { goto: async () => undefined, title: async () => 'Just a moment...', url: () => 'https://codeforces.com/' };
    const internal = browser as unknown as { run: (mode: string, cfg: unknown, callback: (context: unknown) => Promise<unknown>) => Promise<unknown> };
    internal.run = async (_mode, _cfg, callback) => callback({ pages: () => [page] });
    const result = await browser.validateSession(readConfig());
    assert.equal(result.state, 'challenged');
    assert.match(result.message, /Cloudflare/);
  });

  await check('browser work is never silently repeated after an error', async () => {
    const browser = new CfBrowser(vscode.Uri.file('/tmp/cf-test-profile'), () => undefined);
    const internal = browser as unknown as { ensure: () => Promise<unknown> };
    internal.ensure = async () => ({});
    let attempts = 0;
    await assert.rejects(browser.run('headless', readConfig(), async () => {
      attempts++;
      throw new Error('Target page, context or browser has been closed');
    }));
    assert.equal(attempts, 1, 'a submission callback must not be retried implicitly');
  });

  await check('browser queue serializes concurrent commands even after failure', async () => {
    const browser = new CfBrowser(vscode.Uri.file('/tmp/cf-test-profile'), () => undefined);
    (browser as unknown as { ensure: () => Promise<unknown> }).ensure = async () => ({});
    const events: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = browser.run('headless', readConfig(), async () => { events.push('first-start'); await hold; events.push('first-end'); throw new Error('fail'); });
    const second = browser.run('headed', readConfig(), async () => { events.push('second'); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(events, ['first-start']);
    release(); await assert.rejects(first); await second;
    assert.deepEqual(events, ['first-start', 'first-end', 'second']);
  });

  await check('submission escalation never retries an ambiguous or completed attempt', async () => {
    let attempts = 0; let challenges = 0;
    const browser: { run: () => Promise<{ submitted?: boolean }>; resolveChallenge: () => Promise<boolean> } = { run: async () => { attempts++; return { submitted: true }; }, resolveChallenge: async () => { challenges++; return true; } };
    const submitter = new Submitter(browser as unknown as CfBrowser, readConfig, () => new Runner(readConfig));
    const post = (submitter as unknown as { postSubmission: (request: unknown, cfg: unknown) => Promise<unknown> }).postSubmission.bind(submitter);
    const request = { contestId: '4', index: 'A', kind: 'contest', file: '/tmp/A.cpp' };
    await post(request, readConfig());
    assert.equal(attempts, 1); assert.equal(challenges, 0);
    browser.run = async () => { attempts++; return {}; };
    await assert.rejects(post(request, readConfig()), /not confirmed/);
    assert.equal(attempts, 2); assert.equal(challenges, 0);
  });

  await check('Windows compiler paths retain backslashes when quoted', () => {
    assert.deepEqual(splitCommand('"C:\\Program Files\\mingw\\g++.exe" -O2'), ['C:\\Program Files\\mingw\\g++.exe', '-O2']);
  });

  await check('verdict matching never substitutes an unrelated or old submission', () => {
    const submitter = new Submitter({} as CfBrowser, readConfig, () => new Runner(readConfig));
    const find = (submitter as unknown as { findRow: (rows: unknown[], req: unknown, id?: number, baseline?: number) => { id: number } | undefined }).findRow.bind(submitter);
    const req = { contestId: '4', index: 'A' };
    const rows = [{ id: 99, problem: { contestId: 4, index: 'A' } }];
    assert.equal(find(rows, req, 100, 90), undefined);
    assert.equal(find(rows, req), undefined);
    assert.equal(find(rows, req, undefined, 99), undefined);
    assert.equal(find(rows, req, undefined, 98)?.id, 99);
  });

  await check('empty sample output is retained and single-quoted example lines are separated', () => {
    const html = `<div class="sample-tests"><div class="input"><pre><div class='test-example-line'>1</div><div class='test-example-line'>2</div></pre></div><div class="output"><pre></pre></div></div>`;
    const samples = parseSamples(html);
    assert.equal(samples[0]?.input, '1\n2\n');
    assert.equal(samples[0]?.expected, '');
  });

  await check('failed commands are not treated as successful environment probes', async () => {
    assert.equal(await runCapture(process.execPath, ['-e', 'console.log("g++ error"); process.exit(1)']), null);
  });

  section('webview: document and KaTeX rendering');
  const statement = parseProblemPage(PROBLEM_PAGE_HTML, { contestId: '4', index: 'A', kind: 'contest' }, 'https://codeforces.com/contest/4/problem/A');
  const docHtml = buildStatementHtml(statement, { katexStyle: 'vscode-resource:/katex.min.css', katexScript: 'vscode-resource:/katex.min.js', cspSource: 'vscode-resource:' });

  await check('embeds a strict CSP and loads local KaTeX', () => {
    assert.ok(docHtml.includes('Content-Security-Policy'), 'CSP meta tag missing');
    assert.ok(docHtml.includes('https://codeforces.com'), 'codeforces must be allowed for images');
    assert.ok(docHtml.includes('https://espresso.codeforces.com'), 'espresso CDN must be allowed');
    assert.ok(!docHtml.includes('https://cdn.jsdelivr.net'), 'KaTeX must not rely on CDN');
    assert.ok(docHtml.includes('vscode-resource:/katex.min.js'));
    assert.ok(docHtml.includes('style-src &') === false);
    assert.ok(docHtml.includes('font-src data: vscode-resource:'));
    assert.ok(docHtml.includes("default-src 'none'"), 'default-src must be locked down');
    const mainScriptIsAllowed = /script-src 'nonce-[^']+'/.test(docHtml);
    assert.ok(mainScriptIsAllowed, 'the nonce script must be allowed');
  });

  await check('renders header, limits and footer link', () => {
    assert.ok(docHtml.includes('A. Watermelon'), 'title missing');
    assert.ok(docHtml.includes('1 second'), 'time limit missing');
    assert.ok(docHtml.includes('256 megabytes'), 'memory limit missing');
    assert.ok(docHtml.includes('https://codeforces.com/contest/4/problem/A'), 'source link missing');
  });

  await check('runs the KaTeX filter and converts only CF delimiters', () => {
    const virtualConsole = new VirtualConsole();
    const errors: string[] = [];
    virtualConsole.on('jsdomError', (event) => errors.push(String(event)));
    const dom = new JSDOM(docHtml, { runScripts: 'outside-only', virtualConsole });
    const { window } = dom;
    (window as unknown as { katex: unknown }).katex = katex;

    // KaTeX's Node build resolves `document` from the module scope, and in a webview that
    // scope *is* the webview window. Mirror the window onto globalThis for the duration of
    // the run, then restore it so later suites see a clean Node environment.
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = { document: globals.document, window: globals.window };
    globals.document = window.document;
    globals.window = window;
    try {
      // Only the runner script is executed: KaTeX itself would be loaded from a CDN.
      window.eval(KATEX_RUNNER);
    } finally {
      globals.document = saved.document;
      globals.window = saved.window;
    }

    const root = window.document.getElementById('root');
    assert.ok(root, 'root container missing');
    const rendered = root.querySelectorAll('.katex').length;
    assert.ok(rendered >= 3, `expected at least 3 KaTeX nodes (inline, display, note), got ${rendered}`);

    // Inline $$$w$$$ became an inline KaTeX node, not text.
    const bodyText = root.textContent ?? '';
    assert.ok(!bodyText.includes('$$$w$$$'), 'the inline delimiter must be consumed');
    assert.ok(rendered >= 1, 'inline math missing');

    // The display block $$$$...$$$$ produced a .katex-display wrapper.
    const displayBlocks = root.querySelectorAll('.katex-display').length;
    assert.ok(displayBlocks >= 1, 'display math was not wrapped');

    // A literal single-$ price must not be parsed as math.
    assert.ok(bodyText.includes('$5 note'), 'ordinary dollar signs must stay literal');
    assert.ok(!bodyText.includes('$$$'), `stray delimiters survived: ${JSON.stringify(bodyText)}`);
    assert.equal(errors.length, 0, `unexpected jsdom errors: ${errors.join('; ')}`);
  });

  await check('ships a monochrome statement stylesheet', () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(docHtml)?.[1] ?? '';
    assert.ok(css.includes('--bg: #0b0b0b'), 'dark monochrome background missing');
    assert.ok(css.includes('--ink: #ededed'), 'light ink missing');
    assert.ok(css.includes('vscode-light'), 'light theme override missing');
    assert.ok(css.includes('Roboto'), 'Roboto stack missing');
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(css), 'no emoji in the stylesheet');
  });

  await check('loading document keeps the same shell without KaTeX', () => {
    const loading = buildLoadingHtml('Fetching 2045/C...');
    assert.ok(loading.includes('Fetching 2045/C...'));
    assert.ok(!loading.includes('katex.min.js'));
  });

  await check('error screen escapes untrusted errors and posts retry actions', () => {
    const html = buildErrorHtml({ label: 'Problem', title: 'Failed', message: '<script>bad</script>',
      actions: [{ id: 'retry', label: 'Try again', primary: true }] });
    assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const messages: unknown[] = [];
    (dom.window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => messages.push(message) });
    (dom.window as unknown as { katex: unknown }).katex = katex;
    dom.window.eval(KATEX_RUNNER);
    (dom.window.document.querySelector('[data-cf-action="retry"]') as HTMLElement).click();
    assert.equal((messages[0] as { action: string }).action, 'retry');
    dom.window.close();
  });

  await check('math is readable when the local KaTeX script fails', () => {
    const dom = new JSDOM('<div id="root"><p>Value $$$x+1$$$ and $5</p></div>', { runScripts: 'outside-only' });
    let callback: (() => void) | undefined;
    (dom.window as unknown as { setInterval: (fn: () => void) => number }).setInterval = (fn) => { callback = fn; return 1; };
    dom.window.eval(KATEX_RUNNER);
    for (let i = 0; i < 31; i++) { callback?.(); }
    const root = dom.window.document.getElementById('root');
    assert.equal(root?.querySelector('.tex-fallback')?.textContent, 'x+1');
    assert.ok(root?.textContent?.includes('$5'));
    assert.ok(!root?.textContent?.includes('$$$'));
    dom.window.close();
  });

  await check('KaTeX and every referenced font are packaged locally', () => {
    const css = readFileSync(path.join(process.cwd(), 'media/katex/katex.min.css'), 'utf8');
    assert.ok(readFileSync(path.join(process.cwd(), 'media/katex/katex.min.js')).length > 1000);
    const refs = [...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((match) => match[1]);
    assert.ok(refs.length > 0);
    for (const ref of refs) { assert.ok(ref); assert.ok(readFileSync(path.join(process.cwd(), 'media/katex', ref)).length > 0); }
  });

  await check('terminal buffers its initial screen until VS Code opens it', () => {
    const pty = new RunnerPseudoTerminal();
    const captured: string[] = [];
    pty.onDidWrite((chunk) => captured.push(chunk));
    pty.renderStatus({ title: '2045/A', hints: [{ key: 'Run', label: 'Run samples' }] });
    assert.equal(captured.length, 0);
    pty.open();
    assert.match(captured.join(''), /2045\/A/);
    assert.match(captured.join(''), /Run samples/);
    pty.dispose();
  });

  section('runner: real compile + execute against g++');
  const workspaceRoot = path.join(tmpdir(), `cf-vscode-test-${process.pid}`);
  rmSync(workspaceRoot, { recursive: true, force: true });
  mkdirSync(path.join(workspaceRoot, '2045', '.cp', 'A'), { recursive: true });
  const sourceFile = path.join(workspaceRoot, '2045', 'A.cpp');
  writeFileSync(
    sourceFile,
    [
      '#include <bits/stdc++.h>',
      'using namespace std;',
      'int main(){ long long a,b; if(!(cin>>a>>b)) return 0; cout << a+b << "\\n"; return 0; }',
    ].join('\n'),
  );
  writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'A', '1.in'), '4 5\n');
  writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'A', '1.out'), '9\n');
  writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'A', '2.in'), '100 200\n');
  writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'A', '2.out'), '301\n');

  const solution = { root: workspaceRoot, contestId: '2045', index: 'A', file: sourceFile };

  await check('loads cached testcases in numeric order', async () => {
    const tests = await Runner.loadTestCases(solution);
    assert.equal(tests.length, 2);
    assert.equal(tests[0]?.name, '1');
    assert.equal(tests[0]?.expected, '9\n');
  });

  await check('compiles and reports 1 pass / 1 fail with diff metadata', async () => {
    const runner = new Runner(readConfig);
    const result = await runner.runTests(solution);
    runner.dispose();
    assert.equal(result.total, 2);
    assert.equal(result.passed, 1, `expected 1 passing test, got ${result.passed}`);
  });

  section('runner: terminal rendering');
  await check('streams PASS/FAIL lines, diff blocks and a summary', async () => {
    const pty = new RunnerPseudoTerminal();
    const captured: string[] = [];
    pty.onDidWrite((chunk) => captured.push(chunk));
    pty.open();
    // Swap the runner's private terminal so the public API writes into our capture buffer.
    const runner = new Runner(readConfig);
    (runner as unknown as { pty: RunnerPseudoTerminal; terminal: unknown }).pty = pty;
    (runner as unknown as { pty: RunnerPseudoTerminal; terminal: unknown }).terminal = { creationOptions: {} };
    const result = await runner.runTests(solution);
    runner.dispose();

    assert.equal(result.passed, 1);
    const output = captured.join('').replace(/\u001b\[[0-9;]*m/g, '');
    assert.ok(output.includes('PASS'), 'PASS row missing');
    assert.ok(output.includes('FAIL'), 'FAIL row missing');
    assert.ok(output.includes('Test #1'), 'test numbering missing');
    assert.ok(output.includes('Expected'), 'expected block missing');
    assert.ok(output.includes('Actual'), 'actual block missing');
    assert.ok(output.includes('first difference at line 1'), 'diff pointer missing');
    assert.ok(/1\/2 PASSED, 1 FAILED/.test(output), 'summary missing');
    assert.ok(output.includes('total runtime'), 'runtime total missing');
    assert.ok(output.includes('Compiled in'), 'compile timing missing');
    // Every line must be CRLF-terminated for the pseudoterminal renderer.
    assert.ok(!/[^\r]\n/.test(captured.join('')), 'output must use CRLF line endings');
    console.log(
      captured
        .join('')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split('\r\n')
        .map((line) => `       | ${line}`)
        .join('\n'),
    );
  });

  await check('hardReset emits a clear-screen sequence', () => {
    const pty = new RunnerPseudoTerminal();
    const captured: string[] = [];
    pty.onDidWrite((chunk) => captured.push(chunk));
    pty.open();
    pty.writeLine('noise');
    pty.hardReset();
    assert.ok(captured.join('').includes('\u001b[2J'), 'clear-screen escape missing');
    pty.dispose();
  });

  section('runner: TLE and runtime error');
  await check('kills a busy loop and flags TLE', async () => {
    const loopFile = path.join(workspaceRoot, '2045', 'B.cpp');
    writeFileSync(loopFile, 'int main(){ for(volatile long long i=0;;i++){} }\n');
    mkdirSync(path.join(workspaceRoot, '2045', '.cp', 'B'), { recursive: true });
    writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'B', '1.in'), '1\n');
    writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'B', '1.out'), '1\n');
    (globalThis as Record<string, unknown>).__cfg_cfVscode_timeoutMs = 600;
    const runner = new Runner(readConfig);
    const startedAt = Date.now();
    const result = await runner.runTests({ root: workspaceRoot, contestId: '2045', index: 'B', file: loopFile });
    runner.dispose();
    (globalThis as Record<string, unknown>).__cfg_cfVscode_timeoutMs = undefined;
    assert.equal(result.passed, 0);
    assert.ok(Date.now() - startedAt < 20_000, 'the timeout must actually terminate the child');
  });

  await check('reports a non-zero exit as RE', async () => {
    const crashFile = path.join(workspaceRoot, '2045', 'C.cpp');
    writeFileSync(crashFile, '#include <cstdlib>\nint main(){ std::abort(); }\n');
    mkdirSync(path.join(workspaceRoot, '2045', '.cp', 'C'), { recursive: true });
    writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'C', '1.in'), '1\n');
    writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'C', '1.out'), '1\n');
    const runner = new Runner(readConfig);
    const result = await runner.runTests({ root: workspaceRoot, contestId: '2045', index: 'C', file: crashFile });
    runner.dispose();
    assert.equal(result.passed, 0);
    assert.equal(result.total, 1);
  });

  await check('surfaces compiler diagnostics without throwing', async () => {
    const brokenFile = path.join(workspaceRoot, '2045', 'D.cpp');
    writeFileSync(brokenFile, 'int main(){ this is not c++ }\n');
    mkdirSync(path.join(workspaceRoot, '2045', '.cp', 'D'), { recursive: true });
    writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'D', '1.in'), '1\n');
    writeFileSync(path.join(workspaceRoot, '2045', '.cp', 'D', '1.out'), '1\n');
    (globalThis as Record<string, unknown>).__cfg_cfVscode_compilerCommand = undefined;
    const runner = new Runner(readConfig);
    const result = await runner.runTests({ root: workspaceRoot, contestId: '2045', index: 'D', file: brokenFile });
    runner.dispose();
    assert.equal(result.passed, 0);
  });

  rmSync(workspaceRoot, { recursive: true, force: true });

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
