# CF: Codeforces Contest Cockpit

A 100% self-contained Codeforces environment for VS Code. No browser extension, no bridge
server, no clipboard juggling: statements, samples, local judging and direct submission all
live inside the editor, driven by `playwright-core` controlling *your* installed Chrome with a
persistent profile.

```
+----------------+----------------------+----------------------+
|  Statement     |  Solution editor     |  CF Runner terminal  |
|  (WebviewPanel |  2045/A.cpp          |  compile + tests     |
|   + KaTeX)     |                      |  + live verdict poll |
|      30%       |        45%           |        25%           |
+----------------+----------------------+----------------------+
```

## Features

- **Three-column cockpit, pinned programmatically.** Every problem switch re-applies
  `vscode.setEditorLayout` with a 30 / 45 / 25 split, so the layout never drifts mid-contest.
- **Faithful statements.** The exact `.problem-statement` HTML is rendered monochrome with
  KaTeX for Codeforces' `$$$...$$$` (inline) and `$$$$...$$$$` / `$$$$$$...$$$$$$` (display)
  delimiters. Relative and protocol-relative asset URLs are rewritten to `https://` so diagrams
  and formulas render natively. Only CF delimiters are treated as maths, so a literal `$5` in a
  statement stays literal.
- **Instant switching.** Statements and samples are cached under `{contest}/{.cp}/{index}/`.
  After `CF: Load Contest` pre-fetches the remaining problems one at a time, switching is a
  disk read.
- **A terminal that behaves like a judge.** A custom `Pseudoterminal` (no shell prompt, no
  echo, no clutter) prints compile diagnostics, per-test `PASS / FAIL / TLE / RE`, runtimes in
  ms, and a line-numbered expected-vs-actual diff.
- **Real submission, real verdicts.** Fills `contest/{id}/submit` in the persistent Chrome
  profile, handles the Cloudflare Turnstile interstitial by escalating headless → visible, then
  polls `user.status` every 2 s for up to 60 s while streaming live verdicts.

## Install and get started

**You need:** VS Code, Google Chrome (or Chromium / Edge), and a C++ compiler such as `g++`.

1. Get the `cf-vscode-1.0.0.vsix` package. In VS Code open **Extensions**, click the
   **…** menu, choose **Install from VSIX…**, and select the file. Reload if prompted.
2. Open a folder where your contest files should go. Click **Codeforces** in the bottom status
   bar and choose **Check setup** to check your browser and compiler.
3. Choose **Log in to Codeforces** from the same menu. Sign in and complete any Cloudflare
   check in the Chrome window. The extension verifies login in that window and closes it
   automatically when it detects your session.
4. Choose **Load a contest** or **Open a problem**. Write your solution, then use
   **Ctrl+Shift+R** (macOS: **Cmd+Shift+R**) to run the samples.

No template or browser path is required if your browser is in a standard location: the
extension finds it automatically and creates a minimal C++ skeleton. You can set
`cfVscode.templatePath` if you prefer your own template, or `cfVscode.chromePath` if browser
detection misses your installation. Your Codeforces handle is saved after login when it can
be detected; set `cfVscode.handle` manually if needed for verdict polling.

**Building the package from source** (only needed if a VSIX has not been provided):

```bash
cd cf-vscode
npm ci
npm run package
```

This creates `cf-vscode-1.0.0.vsix`, which you can install using the VS Code menu above. The
extension does not need Node.js or npm installed on your computer after installation.

Optional settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `cfVscode.compilerCommand` | `g++ -std=gnu++20 -O2 -Wall -Wextra` | Local compile line. |
| `cfVscode.cfCompilerId` | `89` | Codeforces `programTypeId` (`89` G++23 14.2, `73` G++20 11.2, `54` G++17 7.3). |
| `cfVscode.timeoutMs` | `3000` | Per-testcase timeout in ms. |
| `cfVscode.debugCommand` | `""` | Optional host command for debugging instead of running the binary directly (adds `-g -fsanitize=address,undefined` to the compile). `{binary}` expands to the compiled binary. |

## Use

1. **`CF: Login / Refresh Session`** — opens Chrome at `codeforces.com/enter` with a persistent
   profile in the extension's `globalStorage`. Log in (and clear any Cloudflare check once),
   then wait for the extension to detect your login and close the window. Cookies are saved
   in the profile. If you close it before login is detected, retry the command.
2. **`CF: Load Contest`** — enter `2045`. Problem list comes from
   `contest.standings?from=1&count=1`, `{index}.cpp` files are created from your template
   (existing files are skipped), the contest folder is created, problem A is scraped and opened
   in the cockpit, and the remaining problems are pre-fetched one at a time in the background.
3. **`CF: Switch Problem`** — QuickPick of the contest's problems (rating, tags, cache state).
4. **`CF: Run Tests`** (`⌘⇧R` / `Ctrl+Shift+R`) — compile + run every cached sample.
5. **`CF: Submit Solution`** (`⌘⇧S` / `Ctrl+Shift+S`) — saves, submits, polls the verdict.

Other commands: **`CF: Open Problem`** accepts a URL or `2045/C`, and **`CF: Validate Session
Cookies`** checks whether the saved session still works.

### Runner output

```
CF 2045/A  A.cpp
10:31:05 AM

Compiling A.cpp
  g++ -std=gnu++20 -O2 -Wall -Wextra
Compiled in 412 ms

  PASS   Test #1         8 ms
  FAIL   Test #2         7 ms
    Expected
  > 1 | 301
    Actual
  > 1 | 300
  first difference at line 1

  1/2 PASSED, 1 FAILED
  total runtime 15 ms
```

Verdicts: `PASS`, `FAIL` (WA with diff), `TLE` (killed at `timeoutMs`, including child
processes), `RE` (non-zero exit/signal with the stderr tail), plus an informational row when a
sample has no `.out` file.

## Workspace layout

```
{workspaceRoot}/
└── 2045/
    ├── A.cpp                      # from cfVscode.templatePath
    ├── B.cpp
    └── .cp/
        ├── contest.json           # cached problem list (6 h TTL)
        ├── A/
        │   ├── statement.html     # rewritten, sanitised statement body
        │   ├── meta.json          # title, limits, samples
        │   ├── 1.in  1.out  ...   # editable: local edits win over the cache
        │   └── sol                # compiled binary
        └── B/ ...
```

`.in` / `.out` files are yours: the extension only creates missing files, so edits (and extra
`3.in` cases you add) are never clobbered — including across `CF: Open Problem` refreshes.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation, command wiring, session state (`{contestId, index}` from the active editor path), template materialisation, problem orchestration, background pre-fetch. |
| `src/config.ts` | Typed wrapper around `workspace.getConfiguration('cfVscode')` with defensive defaults. |
| `src/cfBrowser.ts` | Single persistent `chromium.launchPersistentContext` instance, serialised through an async lock (Chrome locks a profile directory), headless/headed switching, Cloudflare + Turnstile detection, login window lifecycle, session validation. |
| `src/scraper.ts` | Codeforces HTML parsing without a DOM: balanced-`<div>` scanning, exact class-token matching, `.sample-test` extraction (`test-example-line` divs joined with `\n`, `innerText` fallback), URL rewriting, HTML sanitising, statement/testcase cache with per-index overlay of local edits. |
| `src/webview.ts` | Left-column `WebviewPanel`, CSP, KaTeX text-node filter for CF delimiters, monochrome stylesheet (dark + light). |
| `src/layout.ts` | `vscode.setEditorLayout` orchestrator (30 / 45 / 25, applied twice to settle the grid). |
| `src/runner.ts` | `Pseudoterminal` in column three plus the compile/execute/diff engine: command tokenising, process groups + tree kill, timeout handling, ANSI rendering. |
| `src/submitter.ts` | Form automation (problem radio, `programTypeId`, source paste + verification, Turnstile wait), Cloudflare escalation, submission-id recovery, `user.status` verdict poller. |

### Notes on the tricky parts

- **Cloudflare.** Headless first. If a challenge is detected, the *same* page is re-opened in a
  visible window and the extension waits for the interstitial to clear; the `cf_clearance`
  cookie it sets lives in the persistent profile, so later runs stay headless. Submissions are
  never retried after a successful POST, so a challenge mid-flow cannot double-submit.
- **Profile locking.** Every browser entry point goes through one queue, so a login window and a
  background pre-fetch can never race the `ProcessSingleton` lock. Stale `Singleton*` files are
  not removed automatically: close other Chrome processes using the profile before retrying.
- **Statement caching vs. samples.** `meta.json` owns sample numbering; `N.in` / `N.out` on disk
  are overlaid per index. Deleting or editing a file therefore cannot re-associate inputs with
  the wrong expected output.
- **Math.** `$...$` is never parsed; only `$$$...$$$`, `$$$$...$$$$` and `$$$$$$...$$$$$$` are.
  Unparseable TeX is shown verbatim rather than vanishing.

## Development

```bash
npm run typecheck    # tsc --noEmit, strict
npm run compile      # esbuild bundle -> dist/extension.js
npm run watch        # rebuild on change
npm test             # typecheck + bundle + tests + activation smoke test
```

`npm test` runs the real logic outside VS Code through a minimal `vscode` stub, then loads the
actual `dist/extension.js` with `vscode` redirected to that stub and activates it. Covered:

- HTML parsing against Codeforces-shaped fixtures (including the `input-output-copier` div that
  a naive parser mistakes for a sample block);
- KaTeX rendering of inline, `$$$$` and `$$$$$$` delimiters in jsdom, asserting that a literal
  `$5` survives;
- the 30 / 45 / 25 payload handed to `vscode.setEditorLayout`;
- cache round-trips that must not touch the network, and local `.in`/`.out` edits winning;
- **real `g++` compiles and executions**: PASS/FAIL diffing, TLE termination of a busy loop,
  runtime errors, compiler diagnostics, and the exact CRLF/ANSI terminal output;
- activation and deactivation of the production bundle, asserting the commands register.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Google Chrome was not found or is not executable` | Set `cfVscode.chromePath` (`/usr/bin/google-chrome`, `C:\Program Files\Google\Chrome\Application\chrome.exe`, ...). |
| `The Codeforces session is not signed in` | Run `CF: Login / Refresh Session` and wait for login to be detected. |
| Cloudflare loop despite logging in | Your IP may require a fresh check: run the login command and solve the check. A headless challenge does not necessarily mean you are signed out. |
| `cfVscode.cfCompilerId "89" is not offered` | Codeforces rotates language ids; the error lists currently available ids — use one of them. |
| `No testcases found` | Re-run `CF: Open Problem` for that index (samples were never scraped), or check `.cp/{index}/`. |
| Sample tests differ from the real judge | Your local compiler/standard differs; compare with `cfVscode.compilerCommand` or submit. |
| `Compile failed: spawn g++ ENOENT` | Install Xcode Command Line Tools / `build-essential`, or set an absolute `cfVscode.compilerCommand`. |

## Privacy and security

- Sessions live only in VS Code's extension `globalStorage` (`chrome-profile/`), never in the
  workspace and never in source control. Delete that folder to sign out completely.
- Statements are sanitised before rendering (`<script>`, `<style>`, inline handlers and
  `javascript:` URLs are stripped) and the webview runs under a strict CSP that allows only
  remote images and local KaTeX resources.
- Codeforces pages and their remote images require network access. KaTeX is bundled locally.
- Respect Codeforces' terms: scraping is paced deliberately (one statement at a time), and
  verdict polling is capped at 60 s per submission.

## Screens (synthetic)

See `docs/preview.html` for a synthetic static render of the statement panel, generated from real
statement HTML by `npm run preview`.
