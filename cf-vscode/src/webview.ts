import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import type { ProblemStatement } from './scraper';

const KATEX_VERSION = '0.16.11';
const KATEX_BASE = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist`;

/** Bulletproof monochrome skin. Deliberately ignores light/dark theme variables. */
const STATEMENT_CSS = String.raw`
:root {
  color-scheme: dark;
  --ink: #ededed;
  --ink-dim: #a8a8a8;
  --ink-faint: #7c7c7c;
  --bg: #0b0b0b;
  --panel: #121212;
  --line: #2a2a2a;
  --line-strong: #3d3d3d;
  --code-bg: #171717;
  --pre-bg: #121212;
}
/* Light workbench theme: same monochrome palette, inverted. No hue anywhere. */
html:has(body.vscode-light),
body.vscode-light {
  color-scheme: light;
  --ink: #101010;
  --ink-dim: #4a4a4a;
  --ink-faint: #6b6b6b;
  --bg: #ffffff;
  --panel: #f5f5f5;
  --line: #dedede;
  --line-strong: #b3b3b3;
  --code-bg: #f2f2f2;
  --pre-bg: #f7f7f7;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--ink);
}
body {
  font-family: "Roboto", "Helvetica Neue", Arial, "Segoe UI", sans-serif;
  font-size: 14.5px;
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
#root {
  max-width: 860px;
  margin: 0 auto;
  padding: 26px 26px 96px;
}
.doc-header {
  border-bottom: 1px solid var(--line-strong);
  padding-bottom: 16px;
  margin-bottom: 22px;
}
.doc-title {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.32;
  margin: 0 0 10px;
}
.doc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.doc-meta span { border: 1px solid var(--line); padding: 2px 8px; }
.doc-link {
  color: var(--ink-dim);
  text-decoration: none;
  border-bottom: 1px solid var(--line-strong);
  font-size: 11.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.doc-link:hover { color: var(--ink); border-bottom-color: var(--ink); }
.loading { color: var(--ink-faint); font-size: 13px; padding: 40px 0; }

/* Codeforces document body */
.problem-statement { margin: 0; }
.problem-statement .header,
.problem-statement .input-output-copier { display: none; }
.problem-statement .section-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-dim);
  margin: 30px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
}
.problem-statement p { margin: 0 0 14px; }
.problem-statement ul,
.problem-statement ol { margin: 0 0 16px; padding-left: 22px; }
.problem-statement li { margin: 0 0 7px; }
.problem-statement a { color: var(--ink); border-bottom: 1px solid var(--line-strong); text-decoration: none; }
.problem-statement a:hover { border-bottom-color: var(--ink); }
.problem-statement b, .problem-statement strong { font-weight: 600; }
.problem-statement em, .problem-statement i { font-style: italic; color: var(--ink); }
.problem-statement img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 14px auto;
  border: 1px solid var(--line);
  /* Codeforces diagrams are drawn on white, so keep a light backing even in dark mode. */
  background: #ffffff;
  padding: 4px;
}
.problem-statement pre {
  font-family: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  line-height: 1.5;
  background: var(--pre-bg);
  border: 1px solid var(--line);
  padding: 12px 14px;
  margin: 0;
  overflow-x: auto;
  white-space: pre;
  tab-size: 4;
}
.problem-statement .sample-test { margin: 4px 0 18px; border: 1px solid var(--line); }
.problem-statement .sample-test .input,
.problem-statement .sample-test .output { padding: 0; }
.problem-statement .sample-test .input + .output { border-top: 1px solid var(--line); }
.problem-statement .sample-test .title {
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-faint);
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  padding: 5px 14px;
}
.problem-statement .sample-test pre { border: 0; background: transparent; }
.problem-statement .tex-graphics, .problem-statement .tex-formula { vertical-align: middle; }
.problem-statement table {
  border-collapse: collapse;
  margin: 12px 0 16px;
  font-size: 13.5px;
  width: 100%;
}
.problem-statement th, .problem-statement td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; }
.problem-statement th { background: var(--panel); font-weight: 600; }
.problem-statement blockquote {
  margin: 14px 0;
  padding: 2px 0 2px 14px;
  border-left: 2px solid var(--line-strong);
  color: var(--ink-dim);
}
.problem-statement code {
  font-family: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12.8px;
  background: var(--code-bg);
  border: 1px solid var(--line);
  padding: 1px 5px;
}
.problem-statement .property-title { color: var(--ink-dim); }
.katex { font-size: 1.03em; }
.katex-display { margin: 16px 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
.katex-display > .katex { color: var(--ink); }
.katex-error { color: var(--ink); border-bottom: 1px dashed var(--line-strong); }
footer.doc-footer {
  margin-top: 38px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
`;

/**
 * Runs inside the webview. Converts Codeforces `$$$...$$$` / `$$$$...$$$$` / `$$$$$$...$$$$$$`
 * delimiters into KaTeX output by walking text nodes with a regular-expression filter, so that
 * ordinary `$...$` sequences in statements, samples and `<pre>` blocks are never mistaken for
 * maths. Only KaTeX's synchronous renderer is required: auto-render is deliberately not used.
 */
export const KATEX_RUNNER = String.raw`
(function () {
  'use strict';
  var root = document.getElementById('root');
  if (!root) { return; }

  // acquireVsCodeApi may only be called once per document.
  var vscodeApi = null;
  try {
    if (typeof acquireVsCodeApi === 'function') { vscodeApi = acquireVsCodeApi(); }
  } catch (error) {
    vscodeApi = null;
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
        } else if (child.classList && child.classList.contains('katex')) {
          // already rendered
        } else {
          walk(child);
        }
      }
      child = next;
    }
  }

  function convert(textNode) {
    var text = textNode.nodeValue;
    if (!text || text.indexOf('$') === -1) { return 0; }
    var pattern = /\$\$\$\$\$\$\s*([\s\S]+?)\s*\$\$\$\$\$\$|\$\$\$\$([\s\S]+?)\$\$\$\$|\$\$\$([\s\S]+?)\$\$\$/g;
    var fragment = document.createDocumentFragment();
    var lastIndex = 0;
    var produced = 0;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      // Group 1: $$$$$$ ... $$$$$$ (display)   Group 2: $$$$ ... $$$$ (display)
      // Group 3: $$$ ... $$$ (inline)
      var display = match[1] !== undefined || match[2] !== undefined;
      var tex = String(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3] || '').trim();
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var holder = document.createElement(display ? 'div' : 'span');
      if (display) { holder.className = 'katex-display'; }
      var ok = false;
      if (tex.length > 0) {
        try {
          if (window.katex) {
            window.katex.render(tex, holder, {
              displayMode: display,
              throwOnError: false,
              strict: 'ignore',
              trust: false,
              output: 'html'
            });
            // KaTeX reports syntax problems as .katex-error nodes instead of throwing.
            ok = holder.querySelector('.katex-error') === null && holder.textContent !== undefined;
          }
        } catch (error) {
          ok = false;
        }
      }
      if (ok) {
        fragment.appendChild(holder);
      } else {
        // Unparseable content is shown verbatim so no information is lost.
        fragment.appendChild(document.createTextNode(match[0]));
      }
      lastIndex = pattern.lastIndex;
      produced += 1;
    }
    if (produced === 0) { return 0; }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.parentNode.replaceChild(fragment, textNode);
    return produced;
  }

  // Give bundled sample images a stable frame and drop copy widgets Codeforces injects.
  function tidy() {
    var copyButtons = root.querySelectorAll('.input-output-copier, .copy-button');
    for (var i = 0; i < copyButtons.length; i += 1) {
      copyButtons[i].style.display = 'none';
    }
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
      } else if (attempts > 40) {
        clearInterval(timer);
      }
    }, 100);
  }

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    if (message.type === 'statement') { window.location.reload(); }
  });

  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a') : null;
    if (anchor && anchor.getAttribute('href')) {
      event.preventDefault();
      var href = anchor.getAttribute('href');
      if (vscodeApi) { vscodeApi.postMessage({ type: 'openLink', url: href }); }
    }
  }, true);
})();
`;

function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface WebviewDeps {
  extensionUri: vscode.Uri;
  onOpenExternal: (url: string) => void;
  onRequestRefresh: () => void;
}

/**
 * Owns the left-column `WebviewPanel`: the Codeforces statement, rendered monochrome.
 * A single panel instance is re-used and re-targeted when the active problem changes.
 */
export class StatementView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private current: ProblemStatement | null = null;
  private loadingMessage: string | null = null;

  constructor(private readonly deps: WebviewDeps) {}

  get isVisible(): boolean {
    return this.panel !== null && this.panel.visible;
  }

  /** Creates the panel in column one if needed, then renders `statement`. */
  show(statement: ProblemStatement, column: vscode.ViewColumn = vscode.ViewColumn.One): void {
    this.current = statement;
    this.loadingMessage = null;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'cfVscode.statement',
        'Statement',
        { viewColumn: column, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.deps.extensionUri],
        },
      );
      this.panel.iconPath = undefined;
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (typeof message !== 'object' || message === null) {
          return;
        }
        const payload = message as { type?: string; url?: string };
        if (payload.type === 'openLink' && typeof payload.url === 'string') {
          this.deps.onOpenExternal(payload.url);
        } else if (payload.type === 'refresh') {
          this.deps.onRequestRefresh();
        }
      });
    }
    this.panel.title = statement.title;
    this.panel.webview.html = this.render(statement);
    if (column !== undefined) {
      this.panel.reveal(column, true);
    }
  }

  /** Shows a temporary "loading" document while the statement is being fetched. */
  showLoading(label: string, column: vscode.ViewColumn = vscode.ViewColumn.One): void {
    this.loadingMessage = label;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'cfVscode.statement',
        'Statement',
        { viewColumn: column, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.deps.extensionUri],
        },
      );
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
    }
    this.panel.title = 'Statement';
    this.panel.webview.html = this.renderLoading(label);
  }

  refresh(): void {
    if (this.panel && this.current) {
      this.panel.webview.html = this.render(this.current);
    } else if (this.panel && this.loadingMessage) {
      this.panel.webview.html = this.renderLoading(this.loadingMessage);
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  /* ------------------------------- rendering ------------------------------ */

  private render(statement: ProblemStatement): string {
    return buildStatementHtml(statement);
  }

  private renderLoading(label: string): string {
    return buildLoadingHtml(label);
  }
}

/* -------------------------------------------------------------------------- */
/* Pure HTML builders (exported for headless verification)                    */
/* -------------------------------------------------------------------------- */

function contentSecurityPolicy(n: string): string {
  return [
    "default-src 'none'",
    'img-src https://codeforces.com https://espresso.codeforces.com https://cdn.jsdelivr.net https: data:',
    `style-src 'unsafe-inline' ${KATEX_BASE}`,
    `font-src ${KATEX_BASE} data:`,
    `script-src 'nonce-${n}' ${KATEX_BASE}`,
    'connect-src https://codeforces.com',
  ].join('; ');
}

function htmlShell(body: string, n: string, withKatex: boolean): string {
  const katexHead = withKatex
    ? `<link rel="stylesheet" href="${KATEX_BASE}/katex.min.css">
    <script nonce="${n}" src="${KATEX_BASE}/katex.min.js"></script>`
    : '';
  const katexScript = withKatex ? `<script nonce="${n}">${KATEX_RUNNER}</script>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(n)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codeforces Statement</title>
${katexHead}
<style>${STATEMENT_CSS}</style>
</head>
<body>
<div id="root">${body}</div>
${katexScript}
</body>
</html>`;
}

/** Full left-column document for a scraped statement. */
export function buildStatementHtml(statement: ProblemStatement): string {
  const n = nonce();
  const href = escapeHtml(statement.sourceUrl);
  const body = `
<article class="problem-statement">
<div class="doc-header">
  <h1 class="doc-title">${escapeHtml(statement.title)}</h1>
  <div class="doc-meta">
    <span>${escapeHtml(statement.timeLimit)}</span>
    <span>${escapeHtml(statement.memoryLimit)}</span>
    <span>${escapeHtml(statement.ref.contestId)} / ${escapeHtml(statement.ref.index)}</span>
  </div>
</div>
${statement.bodyHtml}
</article>
<footer class="doc-footer">
  <a class="doc-link" href="${href}">open on codeforces</a>
  <span>cf-vscode</span>
</footer>`;
  return htmlShell(body, n, true);
}

/** Placeholder document used while a statement is being fetched. */
export function buildLoadingHtml(label: string): string {
  const n = nonce();
  return htmlShell(`<div class="loading">${escapeHtml(label)}</div>`, n, false);
}
