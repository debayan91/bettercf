import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import type { ProblemStatement } from './scraper';

/**
 * The left column. Four deliberate states instead of "blank page":
 *
 *   loading  - skeleton with the problem label and a progress line
 *   ready    - rendered statement
 *   error    - what failed, why, and the buttons that fix it
 *   empty    - onboarding: what to do first
 *
 * KaTeX is vendored in `media/katex`, so nothing here depends on a CDN and the panel works
 * offline (competition wifi is not a thing).
 */

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const SHELL_CSS = String.raw`
:root {
  color-scheme: dark;
  --ink: #ededed;
  --ink-dim: #a8a8a8;
  --ink-faint: #7c7c7c;
  --bg: #0b0b0b;
  --panel: #121212;
  --panel-2: #161616;
  --line: #2a2a2a;
  --line-strong: #3d3d3d;
  --code-bg: #171717;
  --pre-bg: #121212;
  --accent: #ffffff;
}
html:has(body.vscode-light),
body.vscode-light {
  color-scheme: light;
  --ink: #101010;
  --ink-dim: #4a4a4a;
  --ink-faint: #6b6b6b;
  --bg: #ffffff;
  --panel: #f5f5f5;
  --panel-2: #ededed;
  --line: #dedede;
  --line-strong: #b3b3b3;
  --code-bg: #f2f2f2;
  --pre-bg: #f7f7f7;
  --accent: #000000;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); }
body {
  font-family: "Roboto", "Helvetica Neue", Arial, "Segoe UI", sans-serif;
  font-size: 14.5px;
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
#root { max-width: 860px; margin: 0 auto; padding: 26px 26px 96px; }

/* ------------------------------- header --------------------------------- */
.doc-header { border-bottom: 1px solid var(--line-strong); padding-bottom: 16px; margin-bottom: 22px; }
.doc-title { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.32; margin: 0 0 10px; }
.doc-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11.5px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-faint); }
.doc-meta span { border: 1px solid var(--line); padding: 2px 8px; }
.doc-meta span.strong { color: var(--ink-dim); border-color: var(--line-strong); }

/* ------------------------------ statement -------------------------------- */
.problem-statement { margin: 0; }
.problem-statement .header, .problem-statement .input-output-copier { display: none; }
.problem-statement .section-title {
  font-size: 12px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--ink-dim); margin: 30px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line);
}
.problem-statement p { margin: 0 0 14px; }
.problem-statement ul, .problem-statement ol { margin: 0 0 16px; padding-left: 22px; }
.problem-statement li { margin: 0 0 7px; }
.problem-statement a { color: var(--ink); border-bottom: 1px solid var(--line-strong); text-decoration: none; cursor: pointer; }
.problem-statement a:hover { border-bottom-color: var(--ink); }
.problem-statement b, .problem-statement strong { font-weight: 600; }
.problem-statement em, .problem-statement i { font-style: italic; color: var(--ink); }
.problem-statement img { max-width: 100%; height: auto; display: block; margin: 14px auto; border: 1px solid var(--line); background: #ffffff; padding: 4px; }
.problem-statement pre {
  font-family: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px; line-height: 1.5; background: var(--pre-bg); border: 1px solid var(--line);
  padding: 12px 14px; margin: 0; overflow-x: auto; white-space: pre; tab-size: 4;
}
.problem-statement .sample-test { margin: 4px 0 18px; border: 1px solid var(--line); }
.problem-statement .sample-test .input, .problem-statement .sample-test .output { padding: 0; }
.problem-statement .sample-test .input + .output { border-top: 1px solid var(--line); }
.problem-statement .sample-test .title {
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-faint);
  background: var(--panel); border-bottom: 1px solid var(--line); padding: 5px 14px;
}
.problem-statement .sample-test pre { border: 0; background: transparent; }
.problem-statement table { border-collapse: collapse; margin: 12px 0 16px; font-size: 13.5px; width: 100%; }
.problem-statement th, .problem-statement td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; }
.problem-statement th { background: var(--panel); font-weight: 600; }
.problem-statement blockquote { margin: 14px 0; padding: 2px 0 2px 14px; border-left: 2px solid var(--line-strong); color: var(--ink-dim); }
.problem-statement code {
  font-family: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12.8px; background: var(--code-bg); border: 1px solid var(--line); padding: 1px 5px;
}
.katex { font-size: 1.03em; }
.katex-display { margin: 16px 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
.katex-display > .katex { color: var(--ink); }
.tex-fallback { font-family: "SFMono-Regular", Menlo, Consolas, monospace; background: var(--code-bg); padding: 1px 4px; }

/* ------------------------------- footer ---------------------------------- */
footer.doc-footer {
  margin-top: 38px; padding-top: 14px; border-top: 1px solid var(--line);
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint);
}
footer.doc-footer button { all: unset; cursor: pointer; color: var(--ink-dim); border-bottom: 1px solid var(--line-strong); letter-spacing: 0.1em; }
footer.doc-footer button:hover { color: var(--ink); border-bottom-color: var(--ink); }

/* ------------------------------- states ---------------------------------- */
.state { display: flex; flex-direction: column; gap: 18px; padding-top: 6px; }
.state-kicker { font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-faint); }
.state-title { font-size: 19px; font-weight: 600; line-height: 1.35; margin: 0; }
.state-text { color: var(--ink-dim); margin: 0; max-width: 62ch; }
.state-code {
  font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 12px; color: var(--ink-faint);
  background: var(--panel); border: 1px solid var(--line); padding: 10px 12px; margin: 0;
  white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto;
}
.state-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.state-actions button {
  all: unset; cursor: pointer; font: inherit; font-size: 13px; padding: 7px 14px;
  border: 1px solid var(--line-strong); color: var(--ink); background: transparent;
}
.state-actions button:hover { background: var(--panel-2); border-color: var(--ink-dim); }
.state-actions button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); font-weight: 600; }
.state-actions button.primary:hover { opacity: 0.86; }
.steps { counter-reset: step; display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.steps li { counter-increment: step; display: flex; gap: 12px; align-items: flex-start; color: var(--ink-dim); }
.steps li::before {
  content: counter(step); flex: 0 0 auto; width: 20px; height: 20px; line-height: 19px; text-align: center;
  font-size: 11px; color: var(--ink); border: 1px solid var(--line-strong); margin-top: 2px;
}
.steps li b { color: var(--ink); font-weight: 600; }

/* skeleton */
.skeleton { display: flex; flex-direction: column; gap: 12px; }
.sk-bar { height: 12px; background: var(--panel); border: 1px solid var(--line); animation: pulse 1.5s ease-in-out infinite; }
.sk-bar.w40 { width: 40%; } .sk-bar.w70 { width: 70%; } .sk-bar.w90 { width: 90%; } .sk-bar.w60 { width: 60%; }
.sk-block { height: 120px; background: var(--panel); border: 1px solid var(--line); animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
.sk-label { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-faint); }
@media (prefers-reduced-motion: reduce) { .sk-bar, .sk-block { animation: none; opacity: 0.8; } }
`;

/* -------------------------------------------------------------------------- */
/* KaTeX runner                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Converts Codeforces `$$$...$$$` / `$$$$...$$$$` / `$$$$$$...$$$$$$` delimiters via a
 * text-node filter, so ordinary `$...$` in statements, samples and `<pre>` blocks is never
 * mistaken for maths. Falls back to readable monospace text when KaTeX is unavailable, so a
 * statement is never a wall of raw TeX.
 */
export const KATEX_RUNNER = String.raw`
(function () {
  'use strict';
  var root = document.getElementById('root');
  if (!root) { return; }

  var vscodeApi = null;
  try {
    if (typeof acquireVsCodeApi === 'function') { vscodeApi = acquireVsCodeApi(); }
  } catch (error) { vscodeApi = null; }

  function post(message) {
    if (vscodeApi) { vscodeApi.postMessage(message); }
  }

  function walk(node) {
    var child = node.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 3) {
        convert(child);
      } else if (child.nodeType === 1) {
        var tag = child.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') {
          // skip
        } else if (child.classList && (child.classList.contains('katex') || child.classList.contains('tex-fallback'))) {
          // already handled
        } else {
          walk(child);
        }
      }
      child = next;
    }
  }

  function convert(textNode) {
    var text = textNode.nodeValue;
    if (!text || text.indexOf('$') === -1) { return; }
    var pattern = /\$\$\$\$\$\$\s*([\s\S]+?)\s*\$\$\$\$\$\$|\$\$\$\$([\s\S]+?)\$\$\$\$|\$\$\$([\s\S]+?)\$\$\$/g;
    var fragment = document.createDocumentFragment();
    var lastIndex = 0;
    var produced = 0;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      var display = match[1] !== undefined || match[2] !== undefined;
      var tex = String(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3] || '').trim();
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var holder = document.createElement(display ? 'div' : 'span');
      if (display) { holder.className = 'katex-display'; }
      var ok = false;
      if (tex.length > 0 && window.katex) {
        try {
          window.katex.render(tex, holder, {
            displayMode: display,
            throwOnError: false,
            strict: 'ignore',
            trust: false,
            output: 'html'
          });
          ok = holder.querySelector('.katex-error') === null;
        } catch (error) {
          ok = false;
        }
      }
      if (ok) {
        fragment.appendChild(holder);
      } else {
        // No KaTeX (or bad TeX): show the source in monospace instead of raw $$$ noise.
        var fallback = document.createElement(display ? 'div' : 'span');
        fallback.className = 'tex-fallback';
        fallback.textContent = tex;
        fragment.appendChild(fallback);
      }
      lastIndex = pattern.lastIndex;
      produced += 1;
    }
    if (produced === 0) { return; }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.parentNode.replaceChild(fragment, textNode);
  }

  function tidy() {
    var copyButtons = root.querySelectorAll('.input-output-copier, .copy-button');
    for (var i = 0; i < copyButtons.length; i += 1) { copyButtons[i].style.display = 'none'; }
  }

  tidy();
  if (window.katex) {
    walk(root);
  } else {
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (window.katex) {
        clearInterval(timer);
        walk(root);
      } else if (attempts > 30) {
        clearInterval(timer);
        walk(root);
      }
    }, 100);
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) { return; }
    var action = target.closest('[data-cf-action]');
    if (action) {
      event.preventDefault();
      post({ type: 'action', action: action.getAttribute('data-cf-action') });
      return;
    }
    var anchor = target.closest('a');
    if (anchor && anchor.getAttribute('href')) {
      event.preventDefault();
      post({ type: 'openLink', url: anchor.getAttribute('href') });
    }
  }, true);
})();
`;

/* -------------------------------------------------------------------------- */
/* Document builders                                                          */
/* -------------------------------------------------------------------------- */

export interface WebviewAssets {
  /** Absolute paths on disk, converted to webview URIs by the caller. */
  katexScript: string;
  katexStyle: string;
  cspSource?: string;
}

export interface ActionSpec {
  id: string;
  label: string;
  primary?: boolean;
}

function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csp(n: string, assets: WebviewAssets | null): string {
  const local = assets?.cspSource ?? "";
  return [
    "default-src 'none'",
    'img-src https://codeforces.com https://espresso.codeforces.com https: data:',
    `style-src 'unsafe-inline' ${local}`,
    `font-src data: ${local}`,
    `script-src 'nonce-${n}'`,
    'connect-src https://codeforces.com',
  ].join('; ');
}

function shell(body: string, n: string, assets: WebviewAssets | null, withRunner: boolean): string {
  const head = assets
    ? `<link rel="stylesheet" href="${escapeHtml(assets.katexStyle)}">
    <script nonce="${n}" src="${escapeHtml(assets.katexScript)}"></script>`
    : '';
  const runner = withRunner ? `<script nonce="${n}">${KATEX_RUNNER}</script>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(n, assets)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codeforces</title>
${head}
<style>${SHELL_CSS}</style>
</head>
<body>
<div id="root">${body}</div>
${runner}
</body>
</html>`;
}

function actionsHtml(actions: ActionSpec[]): string {
  if (actions.length === 0) {
    return '';
  }
  const buttons = actions
    .map(
      (action) =>
        `<button data-cf-action="${escapeHtml(action.id)}"${action.primary ? ' class="primary"' : ''}>${escapeHtml(
          action.label,
        )}</button>`,
    )
    .join('');
  return `<div class="state-actions">${buttons}</div>`;
}

/** Full left-column document for a scraped statement. */
export function buildStatementHtml(statement: ProblemStatement, assets: WebviewAssets | null = null): string {
  const n = nonce();
  const href = escapeHtml(statement.sourceUrl);
  const body = `
<article class="problem-statement">
<div class="doc-header">
  <h1 class="doc-title">${escapeHtml(statement.title)}</h1>
  <div class="doc-meta">
    <span>${escapeHtml(statement.timeLimit)}</span>
    <span>${escapeHtml(statement.memoryLimit)}</span>
    <span class="strong">${escapeHtml(statement.ref.contestId)} / ${escapeHtml(statement.ref.index)}</span>
    <span>${statement.samples.length} sample${statement.samples.length === 1 ? '' : 's'}</span>
  </div>
</div>
${statement.bodyHtml}
</article>
<footer class="doc-footer">
  <a href="${href}">open on codeforces</a>
  <button data-cf-action="refresh">refetch statement</button>
</footer>`;
  return shell(body, n, assets, true);
}

/** Skeleton shown while a statement is being fetched. */
export function buildLoadingHtml(label: string, hint = 'This can take a moment. If Cloudflare asks, complete the check in Chrome.', assets: WebviewAssets | null = null): string {
  const n = nonce();
  const body = `
<div class="state">
  <div class="state-kicker">${escapeHtml(label)}</div>
  <div class="skeleton">
    <div class="sk-bar w40"></div>
    <div class="sk-bar w90"></div>
    <div class="sk-bar w70"></div>
    <div class="sk-block"></div>
    <div class="sk-bar w60"></div>
    <div class="sk-bar w70"></div>
  </div>
  <p class="state-text">${escapeHtml(hint)}</p>
</div>`;
  return shell(body, n, assets, false);
}

/** Error state with the actions that actually resolve it. */
export function buildErrorHtml(options: {
  label: string;
  title: string;
  message: string;
  detail?: string;
  actions: ActionSpec[];
}): string {
  const n = nonce();
  const body = `
<div class="state">
  <div class="state-kicker">${escapeHtml(options.label)}</div>
  <h2 class="state-title">${escapeHtml(options.title)}</h2>
  <p class="state-text">${escapeHtml(options.message)}</p>
  ${actionsHtml(options.actions)}
  ${options.detail ? `<pre class="state-code">${escapeHtml(options.detail)}</pre>` : ''}
</div>`;
  return shell(body, n, null, true);
}

/** Empty state: the first thing a coder sees, with the next steps spelled out. */
export function buildEmptyHtml(options: {
  title: string;
  kicker: string;
  text: string;
  steps: Array<{ title: string; detail: string }>;
  actions: ActionSpec[];
}): string {
  const n = nonce();
  const steps = options.steps
    .map((step) => `<li><div><b>${escapeHtml(step.title)}</b><br>${escapeHtml(step.detail)}</div></li>`)
    .join('');
  const body = `
<div class="state">
  <div class="state-kicker">${escapeHtml(options.kicker)}</div>
  <h2 class="state-title">${escapeHtml(options.title)}</h2>
  <p class="state-text">${escapeHtml(options.text)}</p>
  ${actionsHtml(options.actions)}
  <ol class="steps">${steps}</ol>
</div>`;
  return shell(body, n, null, true);
}


export interface WebviewDeps {
  extensionUri: vscode.Uri;
  onOpenExternal(url: string): void;
  onRequestRefresh(): void;
  onRetry?(): void;
  onLogin?(): void;
}

/** Reuses a single panel, including its message handler for every UI state. */
export class StatementView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  constructor(private readonly deps: WebviewDeps) {}

  get isVisible(): boolean { return !!this.panel?.visible; }

  private ensure(column: vscode.ViewColumn): vscode.WebviewPanel {
    if (this.panel) { return this.panel; }
    const panel = vscode.window.createWebviewPanel('cfVscode.statement', 'Statement',
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.deps.extensionUri] });
    this.panel = panel;
    panel.onDidDispose(() => { if (this.panel === panel) { this.panel = null; } });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') { return; }
      const data = message as { type?: string; action?: string; url?: string };
      if (data.type === 'openLink' && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
        this.deps.onOpenExternal(data.url);
      } else if (data.type === 'action') {
        if (data.action === 'refresh') { this.deps.onRequestRefresh(); }
        if (data.action === 'retry') { this.deps.onRetry?.(); }
        if (data.action === 'login') { this.deps.onLogin?.(); }
      }
    });
    return panel;
  }

  private assets(panel: vscode.WebviewPanel): WebviewAssets {
    const resource = (...segments: string[]): string =>
      panel.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'katex', ...segments)).toString();
    return { katexScript: resource('katex.min.js'), katexStyle: resource('katex.min.css'), cspSource: panel.webview.cspSource };
  }

  show(statement: ProblemStatement, column = vscode.ViewColumn.One): void {
    const panel = this.ensure(column);
    panel.title = statement.title;
    panel.webview.html = buildStatementHtml(statement, this.assets(panel));
    panel.reveal(column, true);
  }

  showLoading(label: string, column = vscode.ViewColumn.One): void {
    const panel = this.ensure(column);
    panel.title = 'Loading statement';
    panel.webview.html = buildLoadingHtml(label);
    panel.reveal(column, true);
  }

  showError(message: string, column = vscode.ViewColumn.One): void {
    const panel = this.ensure(column);
    panel.title = 'Statement unavailable';
    panel.webview.html = buildErrorHtml({ label: 'Statement unavailable', title: 'Could not load this problem', message,
      actions: [{ id: 'retry', label: 'Try again', primary: true }, { id: 'login', label: 'Log in' }] });
    panel.reveal(column, true);
  }

  dispose(): void { this.panel?.dispose(); this.panel = null; }
}
