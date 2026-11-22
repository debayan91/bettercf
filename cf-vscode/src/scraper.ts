import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Page } from 'playwright-core';
import * as vscode from 'vscode';

import { CfBrowser, BrowserLog } from './cfBrowser';
import { CfConfig } from './config';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type ContestKind = 'contest' | 'gym';

export interface ProblemRef {
  contestId: string;
  index: string;
  kind: ContestKind;
  title?: string;
}

export interface ContestProblem extends ProblemRef {
  name: string;
  points?: number;
  rating?: number;
  tags: string[];
}

export interface SampleTest {
  input: string;
  expected?: string;
}

export interface ProblemStatement {
  ref: ProblemRef;
  title: string;
  timeLimit: string;
  memoryLimit: string;
  /** Sanitised, URL-rewritten inner HTML of `.problem-statement` (header stripped). */
  bodyHtml: string;
  samples: SampleTest[];
  sourceUrl: string;
  fetchedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Small HTML helpers (no DOM dependency: keeps the bundle self-contained)     */
/* -------------------------------------------------------------------------- */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  laquo: '\u00ab',
  raquo: '\u00bb',
  times: '\u00d7',
  middot: '\u00b7',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
  shy: '\u00ad',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Finds the index of the `</div>` that closes the element whose content starts at `from`. */
function findDivEnd(html: string, from: number): number {
  const tagRe = /<div\b[^>]*>|<\/div\s*>/gi;
  tagRe.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return match.index;
      }
    } else {
      depth += 1;
    }
  }
  return -1;
}

interface DivMatch {
  /** Index right after the opening tag. */
  contentStart: number;
  /** Index of the closing tag. */
  contentEnd: number;
  /** Complete element, including tags. */
  outer: string;
  /** Inner HTML. */
  inner: string;
  /** Full attribute string of the opening tag. */
  attributes: string;
}

/** Reads the raw `class` attribute value of a tag's attribute string. */
function readClassAttribute(attributes: string): string {
  const quoted = /\bclass\s*=\s*"([^"]*)"|\bclass\s*=\s*'([^']*)'/i.exec(attributes);
  return (quoted?.[1] ?? quoted?.[2] ?? '').trim();
}

/**
 * Collects `<div>` elements whose `class` attribute contains `className` as an *exact* token.
 *
 * Exact-token matching matters: Codeforces ships `class="input-output-copier"` next to
 * `class="input"`, and a naive substring test would treat the copy button as a sample block.
 */
function findDivsByClass(html: string, className: string): DivMatch[] {
  const results: DivMatch[] = [];
  const openRe = /<div\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(html)) !== null) {
    const attributes = match[1] ?? '';
    const classes = readClassAttribute(attributes).split(/\s+/).filter(Boolean);
    if (!classes.includes(className)) {
      continue;
    }
    const contentStart = match.index + match[0].length;
    const contentEnd = findDivEnd(html, contentStart);
    if (contentEnd < 0) {
      break;
    }
    const closeLen = html.slice(contentEnd).match(/^<\/div\s*>/i)?.[0].length ?? 6;
    results.push({
      contentStart,
      contentEnd,
      outer: html.slice(match.index, contentEnd + closeLen),
      inner: html.slice(contentStart, contentEnd),
      attributes,
    });
    // Nested containers (e.g. `.sample-tests` > `.sample-test`) must still be discoverable,
    // so the scan resumes after the opening tag rather than after the element.
    openRe.lastIndex = contentStart;
  }
  // Guard against pathological pages: identical start offsets are never useful twice.
  const seen = new Set<number>();
  return results.filter((item) => {
    if (seen.has(item.contentStart)) {
      return false;
    }
    seen.add(item.contentStart);
    return true;
  });
}

/** Removes every `<script>` / `<style>` / inline event handler from untrusted HTML. */
function sanitiseHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

/** Turns arbitrary markup into plain text, preserving line breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/** Rewrites Codeforces-relative asset/link URLs to absolute `https://` URLs. */
export function rewriteUrls(html: string): string {
  return html.replace(/\b(src|href|data-src)\s*=\s*"([^"]*)"/gi, (_whole, attr: string, url: string) => {
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('#') || /^(https?:|data:|mailto:)/i.test(trimmed)) {
      return `${attr}="${trimmed}"`;
    }
    if (trimmed.startsWith('//')) {
      return `${attr}="https:${trimmed}"`;
    }
    if (trimmed.startsWith('/')) {
      return `${attr}="https://codeforces.com${trimmed}"`;
    }
    return `${attr}="https://codeforces.com/${trimmed}"`;
  });
}

function normaliseTestText(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  const withoutTrailingBlankLines = text.replace(/\n+$/g, '');
  return withoutTrailingBlankLines.length > 0 ? `${withoutTrailingBlankLines}\n` : '';
}

/** Extracts a `<pre>` block from a sample `.input` / `.output` container. */
function extractPreText(containerHtml: string): string | null {
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(containerHtml);
  if (!pre || pre[1] === undefined) {
    return null;
  }
  const inner = pre[1];
  const lineRe = /<div[^>]*class\s*=\s*"[^"]*\btest-example-line\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  const lines: string[] = [];
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = lineRe.exec(inner)) !== null) {
    lines.push(htmlToText(lineMatch[1] ?? '').replace(/\n+$/g, ''));
  }
  if (lines.length > 0) {
    return lines.join('\n');
  }
  return htmlToText(inner);
}

/**
 * Parses every sample pair from a problem statement.
 *
 * Samples live as `.sample-test > .input` / `.output`; the outer `.sample-tests` container is
 * used as the search root when present so no sample block is missed.
 */
export function parseSamples(statementsHtml: string): SampleTest[] {
  const root = findDivsByClass(statementsHtml, 'sample-tests')[0]?.inner ?? statementsHtml;

  const inputs = findDivsByClass(root, 'input').sort((a, b) => a.contentStart - b.contentStart);
  const outputs = findDivsByClass(root, 'output').sort((a, b) => a.contentStart - b.contentStart);
  const samples: SampleTest[] = [];

  for (let i = 0; i < inputs.length; i += 1) {
    const inputBlock = inputs[i];
    if (!inputBlock) {
      continue;
    }
    const inputText = extractPreText(inputBlock.inner);
    const outputBlock = outputs[i];
    const outputText = outputBlock ? extractPreText(outputBlock.inner) : null;
    if (inputText === null) {
      continue;
    }
    const sample: SampleTest = { input: normaliseTestText(inputText) };
    if (outputText !== null && outputText.trim().length > 0) {
      sample.expected = normaliseTestText(outputText);
    }
    samples.push(sample);
  }
  return samples;
}

export function problemUrl(ref: ProblemRef): string {
  return `https://codeforces.com/${ref.kind}/${ref.contestId}/problem/${ref.index}`;
}

/* -------------------------------------------------------------------------- */
/* Workspace paths                                                            */
/* -------------------------------------------------------------------------- */

export function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('Open a folder in VS Code before using the CF extension.');
  }
  return folder.uri.fsPath;
}

export function contestDir(root: string, contestId: string): string {
  return path.join(root, contestId);
}

export function problemDir(root: string, contestId: string, index: string): string {
  return path.join(root, contestId, '.cp', index);
}

export function solutionPath(root: string, contestId: string, index: string): string {
  return path.join(root, contestId, `${index}.cpp`);
}

/* -------------------------------------------------------------------------- */
/* Input parsing                                                              */
/* -------------------------------------------------------------------------- */

/** Accepts `2045/C`, `2045 C`, `https://codeforces.com/contest/2045/problem/C`, gym URLs, ... */
export function parseProblemInput(raw: string): ProblemRef | null {
  const input = raw.trim();
  if (!input) {
    return null;
  }
  const urlMatch =
    /codeforces\.com\/(?:(contest|gym)\/(\d+)\/problem\/(?:[^/?#]*?\/)?([A-Za-z]\d?)|problemset\/problem\/(\d+)\/([A-Za-z]\d?))/i.exec(
      input,
    );
  if (urlMatch) {
    const kind = (urlMatch[1]?.toLowerCase() as ContestKind | undefined) ?? 'contest';
    const contestId = urlMatch[2] ?? urlMatch[4] ?? '';
    const index = (urlMatch[3] ?? urlMatch[5] ?? '').toUpperCase();
    if (contestId && index) {
      return { contestId, index, kind };
    }
  }
  const shortMatch = /^(\d+)\s*[/\- ]\s*([A-Za-z]\d?)$/.exec(input);
  if (shortMatch?.[1] && shortMatch[2]) {
    return { contestId: shortMatch[1], index: shortMatch[2].toUpperCase(), kind: 'contest' };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Scraper                                                                    */
/* -------------------------------------------------------------------------- */

interface ContestCacheEntry {
  fetchedAt: number;
  problems: ContestProblem[];
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export class Scraper {
  constructor(
    private readonly browser: CfBrowser,
    private readonly config: () => CfConfig,
    private readonly log: BrowserLog,
  ) {}

  /* ---------------------------- problem lists ---------------------------- */

  private contestCachePath(root: string, contestId: string): string {
    return path.join(contestDir(root, contestId), '.cp', 'contest.json');
  }

  async readCachedProblemList(root: string, contestId: string): Promise<ContestProblem[] | null> {
    try {
      const raw = await fsp.readFile(this.contestCachePath(root, contestId), 'utf8');
      const parsed = JSON.parse(raw) as ContestCacheEntry;
      if (!Array.isArray(parsed.problems) || parsed.problems.length === 0) {
        return null;
      }
      if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) {
        return null;
      }
      return parsed.problems;
    } catch {
      return null;
    }
  }

  private async writeContestCache(root: string, contestId: string, problems: ContestProblem[]): Promise<void> {
    const target = this.contestCachePath(root, contestId);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const payload: ContestCacheEntry = { fetchedAt: Date.now(), problems };
    await fsp.writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
  }

  /** Fetches the problem list through the official API, falling back to page scraping. */
  async fetchProblemList(root: string, contestId: string, kind: ContestKind = 'contest'): Promise<ContestProblem[]> {
    const cached = await this.readCachedProblemList(root, contestId);
    if (cached) {
      this.log(`Contest ${contestId}: ${cached.length} problems (cached).`);
      return cached;
    }

    try {
      const problems = await this.fetchProblemListFromApi(contestId, kind);
      if (problems.length > 0) {
        await this.writeContestCache(root, contestId, problems);
        this.log(`Contest ${contestId}: ${problems.length} problems (API).`);
        return problems;
      }
    } catch (error) {
      this.log(`API problem list failed (${error instanceof Error ? error.message : String(error)}); scraping instead.`);
    }

    const problems = await this.fetchProblemListFromPage(contestId, kind);
    if (problems.length === 0) {
      throw new Error(`No problems found for contest ${contestId}. Check the contest id.`);
    }
    await this.writeContestCache(root, contestId, problems);
    this.log(`Contest ${contestId}: ${problems.length} problems (page).`);
    return problems;
  }

  private async fetchProblemListFromApi(contestId: string, kind: ContestKind): Promise<ContestProblem[]> {
    const endpoint =
      `https://codeforces.com/api/contest.standings?contestId=${encodeURIComponent(contestId)}` +
      '&from=1&count=1&showUnofficial=false';
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': 'cf-vscode/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      status?: string;
      comment?: string;
      result?: {
        problems?: Array<{
          index?: string;
          name?: string;
          points?: number;
          rating?: number;
          tags?: string[];
          type?: string;
        }>;
      };
    };
    if (payload.status !== 'OK' || !payload.result?.problems) {
      throw new Error(payload.comment ?? 'unexpected API payload');
    }
    return payload.result.problems
      .filter((problem) => typeof problem.index === 'string' && problem.index.length > 0)
      .map((problem) => ({
        contestId,
        index: (problem.index ?? '').toUpperCase(),
        kind,
        name: problem.name ?? `Problem ${problem.index}`,
        points: problem.points,
        rating: problem.rating,
        tags: problem.tags ?? [],
      }));
  }

  private async fetchProblemListFromPage(contestId: string, kind: ContestKind): Promise<ContestProblem[]> {
    const url = `https://codeforces.com/${kind}/${contestId}`;
    const html = await this.fetchPageHtml(url);
    const problems: ContestProblem[] = [];
    const seen = new Set<string>();
    const linkRe = new RegExp(
      `href="(?:https://codeforces\\.com)?/${kind}/${contestId}/problem/([A-Za-z]\\d?)"`,
      'gi',
    );
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(html)) !== null) {
      const index = (match[1] ?? '').toUpperCase();
      if (!index || seen.has(index)) {
        continue;
      }
      seen.add(index);
      problems.push({ contestId, index, kind, name: `Problem ${index}`, tags: [] });
    }
    return problems.sort((a, b) => a.index.localeCompare(b.index, 'en', { numeric: true }));
  }

  /* ------------------------------ statements ----------------------------- */

  private async ensureDir(target: string): Promise<void> {
    await fsp.mkdir(target, { recursive: true });
  }

  /** Loads a statement from disk when present (instant switching), otherwise scrapes it. */
  async getStatement(root: string, ref: ProblemRef, options: { force?: boolean } = {}): Promise<ProblemStatement> {
    const dir = problemDir(root, ref.contestId, ref.index);
    const statementFile = path.join(dir, 'statement.html');
    const metaFile = path.join(dir, 'meta.json');

    if (!options.force) {
      const cached = await this.readCachedStatement(root, statementFile, metaFile, ref);
      if (cached) {
        // Never leave a cached problem without runnable inputs: if the user deleted the
        // sample files, restore them from meta.json instead of silently having 0 tests.
        await this.ensureSampleFiles(root, cached);
        return cached;
      }
    }

    const fresh = await this.scrapeStatement(ref);
    await this.persistStatement(root, fresh);
    return fresh;
  }

  /** Re-creates any missing `N.in` / `N.out` file from the cached sample list. */
  private async ensureSampleFiles(root: string, statement: ProblemStatement): Promise<void> {
    if (statement.samples.length === 0) {
      return;
    }
    const dir = problemDir(root, statement.ref.contestId, statement.ref.index);
    let restored = 0;
    for (let i = 0; i < statement.samples.length; i += 1) {
      const sample = statement.samples[i];
      if (!sample) {
        continue;
      }
      const inFile = path.join(dir, `${i + 1}.in`);
      if (!(await this.fileExists(inFile))) {
        await fsp.writeFile(inFile, ensureTrailingNewline(sample.input), 'utf8');
        restored += 1;
      }
      const outFile = path.join(dir, `${i + 1}.out`);
      if (sample.expected !== undefined && !(await this.fileExists(outFile))) {
        await fsp.writeFile(outFile, ensureTrailingNewline(sample.expected), 'utf8');
        restored += 1;
      }
    }
    if (restored > 0) {
      this.log(`Restored ${restored} cached testcase file(s) for ${statement.ref.contestId}/${statement.ref.index}.`);
    }
  }

  private async readCachedStatement(
    root: string,
    statementFile: string,
    metaFile: string,
    ref: ProblemRef,
  ): Promise<ProblemStatement | null> {
    try {
      const [html, metaRaw] = await Promise.all([
        fsp.readFile(statementFile, 'utf8'),
        fsp.readFile(metaFile, 'utf8').catch(() => '{}'),
      ]);
      if (!html.trim()) {
        return null;
      }
      const meta = JSON.parse(metaRaw) as {
        title?: string;
        timeLimit?: string;
        memoryLimit?: string;
        samples?: SampleTest[];
        sourceUrl?: string;
        fetchedAt?: number;
      };
      // meta.json owns the sample *numbering*; local edits to `N.in` / `N.out` are overlaid
      // per index, so deleting or editing one file can never re-associate inputs and outputs.
      const samples = await this.overlayLocalEdits(root, ref, meta.samples ?? []);
      return {
        ref,
        title: meta.title ?? `${ref.index}. ${ref.title ?? 'Problem'}`,
        timeLimit: meta.timeLimit ?? 'unknown',
        memoryLimit: meta.memoryLimit ?? 'unknown',
        bodyHtml: html,
        samples,
        sourceUrl: meta.sourceUrl ?? problemUrl(ref),
        fetchedAt: meta.fetchedAt ?? 0,
      };
    } catch {
      return null;
    }
  }

  /** Replaces cached sample text with the contents of the matching `N.in` / `N.out` files. */
  private async overlayLocalEdits(root: string, ref: ProblemRef, samples: SampleTest[]): Promise<SampleTest[]> {
    const dir = problemDir(root, ref.contestId, ref.index);
    const merged: SampleTest[] = [];
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      if (!sample) {
        continue;
      }
      const diskInput = await fsp.readFile(path.join(dir, `${i + 1}.in`), 'utf8').catch(() => undefined);
      const diskOutput = await fsp.readFile(path.join(dir, `${i + 1}.out`), 'utf8').catch(() => undefined);
      const input = diskInput !== undefined ? diskInput : sample.input;
      const expected = diskOutput !== undefined ? diskOutput : sample.expected;
      merged.push(expected !== undefined ? { input, expected } : { input });
    }
    return merged;
  }

  private async persistStatement(root: string, statement: ProblemStatement): Promise<void> {
    const dir = problemDir(root, statement.ref.contestId, statement.ref.index);
    await this.ensureDir(dir);
    await fsp.writeFile(path.join(dir, 'statement.html'), statement.bodyHtml, 'utf8');
    await fsp.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        {
          title: statement.title,
          timeLimit: statement.timeLimit,
          memoryLimit: statement.memoryLimit,
          sourceUrl: statement.sourceUrl,
          samples: statement.samples,
          fetchedAt: statement.fetchedAt,
        },
        null,
        2,
      ),
      'utf8',
    );

    // Samples -> 1.in / 1.out (only rewritten when the content actually changed,
    // so an in-place edit of an .in file is not clobbered by a re-render).
    for (let i = 0; i < statement.samples.length; i += 1) {
      const sample = statement.samples[i];
      if (!sample) {
        continue;
      }
      const inFile = path.join(dir, `${i + 1}.in`);
      if (!(await this.fileExists(inFile))) {
        await fsp.writeFile(inFile, ensureTrailingNewline(sample.input), 'utf8');
      }
      const outFile = path.join(dir, `${i + 1}.out`);
      if (sample.expected !== undefined && !(await this.fileExists(outFile))) {
        await fsp.writeFile(outFile, ensureTrailingNewline(sample.expected), 'utf8');
      }
    }
  }

  private async fileExists(target: string): Promise<boolean> {
    try {
      await fsp.access(target, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Scrapes a single problem statement through the persistent browser session. */
  async scrapeStatement(ref: ProblemRef): Promise<ProblemStatement> {
    const primaryUrl = problemUrl(ref);
    let html: string;
    try {
      html = await this.fetchPageHtml(primaryUrl, '.problem-statement');
    } catch (error) {
      // Contest vs gym ids share the same URL shape but not the same namespace; retry once
      // with the other prefix before giving up.
      const alternateKind: ContestKind = ref.kind === 'gym' ? 'contest' : 'gym';
      const alternateRef: ProblemRef = { ...ref, kind: alternateKind };
      try {
        html = await this.fetchPageHtml(problemUrl(alternateRef), '.problem-statement');
        ref.kind = alternateKind;
      } catch {
        throw error;
      }
    }
    const statement = parseProblemPage(html, ref, problemUrl(ref));
    this.log(`Loaded ${ref.contestId}/${ref.index} "${statement.title}" (${statement.samples.length} samples).`);
    return statement;
  }

  /**
   * Fetches a Codeforces page as HTML. Uses the persistent headless session first; if
   * Cloudflare intercepts, a visible window is opened for a one-click challenge.
   */
  private async fetchPageHtml(url: string, waitForSelector?: string): Promise<string> {
    const cfg = this.config();
    const attempt = async (mode: 'headless' | 'headed'): Promise<{ html: string; challenged: boolean }> =>
      this.browser.run(mode, cfg, async (context) => {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const challenged = await CfBrowser.isChallenge(page);
        if (challenged) {
          return { html: '', challenged: true };
        }
        if (waitForSelector) {
          await page.waitForSelector(waitForSelector, { timeout: 20_000 }).catch(() => undefined);
        }
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        return { html: await page.content(), challenged: false };
      });

    let result = await attempt('headless');
    if (result.challenged) {
      this.log('Cloudflare challenge on the request. Opening a Chrome window...');
      const cleared = await this.browser.resolveChallenge(cfg, url, this.log);
      if (!cleared) {
        throw new Error('The Cloudflare challenge was not completed, request aborted.');
      }
      result = await attempt('headless');
    }
    if (result.challenged || !result.html) {
      const fallback = await attempt('headed');
      if (fallback.challenged || !fallback.html) {
        throw new Error(`Could not load ${url}: the page is still behind a Cloudflare challenge.`);
      }
      return fallback.html;
    }
    return result.html;
  }

  /** Pre-fetches statements one at a time, so switching problems later is instant. */
  async prefetchStatements(
    root: string,
    refs: ProblemRef[],
    isCancelled: () => boolean,
    onProgress?: (ref: ProblemRef) => void,
  ): Promise<void> {
    for (const ref of refs) {
      if (isCancelled()) {
        return;
      }
      const statementFile = path.join(problemDir(root, ref.contestId, ref.index), 'statement.html');
      if (await this.fileExists(statementFile)) {
        continue;
      }
      try {
        const statement = await this.getStatement(root, ref);
        void statement;
        onProgress?.(ref);
      } catch (error) {
        this.log(
          `Prefetch ${ref.contestId}/${ref.index} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Deliberate 1-at-a-time pacing: Codeforces rate-limits aggressive scrapers.
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
}

function ensureTrailingNewline(text: string): string {
  if (!text) {
    return '';
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

/* -------------------------------------------------------------------------- */
/* Statement parsing                                                          */
/* -------------------------------------------------------------------------- */

/** Parses the raw page HTML into a `ProblemStatement`. Exported for tests. */
export function parseProblemPage(pageHtml: string, ref: ProblemRef, sourceUrl: string): ProblemStatement {
  const statements = findDivsByClass(pageHtml, 'problem-statement');
  const statement = statements[0];
  if (!statement) {
    const title = /<title>([\s\S]*?)<\/title>/i.exec(pageHtml)?.[1] ?? '';
    throw new Error(
      `The problem page for ${ref.contestId}/${ref.index} did not contain a statement. ` +
        `Page title: "${htmlToText(title).trim() || 'unknown'}". Are you logged in and is the problem public?`,
    );
  }

  const rawInner = statement.inner;
  const header = findDivsByClass(rawInner, 'header')[0];
  const headerHtml = header?.outer ?? '';
  const bodyWithoutHeader = header ? rawInner.replace(header.outer, '') : rawInner;

  const titleHtml = findDivsByClass(rawInner, 'title')[0]?.inner ?? '';
  const title = htmlToText(titleHtml).replace(/\s+/g, ' ').trim() || `${ref.index}. Problem`;

  const timeLimit = cleanLimit(
    htmlToText(findDivsByClass(headerHtml, 'time-limit')[0]?.inner ?? ''),
    'time limit per test',
  );
  const memoryLimit = cleanLimit(
    htmlToText(findDivsByClass(headerHtml, 'memory-limit')[0]?.inner ?? ''),
    'memory limit per test',
  );

  const samples = parseSamples(rawInner);
  const bodyHtml = rewriteUrls(sanitiseHtml(bodyWithoutHeader));

  return {
    ref,
    title,
    timeLimit: timeLimit || 'unknown',
    memoryLimit: memoryLimit || 'unknown',
    bodyHtml,
    samples,
    sourceUrl,
    fetchedAt: Date.now(),
  };
}

function cleanLimit(text: string, label: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const lowered = compact.toLowerCase();
  const labelIndex = lowered.indexOf(label);
  const cut = labelIndex >= 0 ? compact.slice(labelIndex + label.length) : compact;
  return cut.replace(/^\s*:?\s*/i, '').replace(/\s+/g, ' ').trim();
}

/** Reads an optional cached statement for a problem, or `null` when not cached. */
export async function cachedStatementJson(root: string, ref: ProblemRef): Promise<ProblemStatement | null> {
  try {
    const dir = problemDir(root, ref.contestId, ref.index);
    const [html, metaRaw] = await Promise.all([
      fsp.readFile(path.join(dir, 'statement.html'), 'utf8'),
      fsp.readFile(path.join(dir, 'meta.json'), 'utf8'),
    ]);
    const meta = JSON.parse(metaRaw) as {
      title?: string;
      timeLimit?: string;
      memoryLimit?: string;
      samples?: SampleTest[];
      sourceUrl?: string;
      fetchedAt?: number;
    };
    return {
      ref,
      title: meta.title ?? `${ref.index}. Problem`,
      timeLimit: meta.timeLimit ?? 'unknown',
      memoryLimit: meta.memoryLimit ?? 'unknown',
      bodyHtml: html,
      samples: meta.samples ?? [],
      sourceUrl: meta.sourceUrl ?? problemUrl(ref),
      fetchedAt: meta.fetchedAt ?? 0,
    };
  } catch {
    return null;
  }
}

export type { Page };
