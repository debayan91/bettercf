import * as path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import * as vscode from 'vscode';

import { CfBrowser } from './cfBrowser';
import { CfConfig } from './config';
import { ContestKind } from './scraper';
import type { Runner } from './runner';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;
const CHALLENGE_TIMEOUT_MS = 10 * 60 * 1000;
const SUBMIT_URL = (kind: ContestKind, contestId: string): string =>
  `https://codeforces.com/${kind}/${contestId}/submit`;

export interface SubmitRequest {
  kind: ContestKind;
  contestId: string;
  index: string;
  /** Absolute path of the `.cpp` file on disk. */
  file: string;
  problemName?: string;
}

/** Result of one pass over the submit form. */
interface AttemptResult {
  /** A Cloudflare interstitial blocked this pass. */
  challenged?: boolean;
  /** The form was actually posted (even if the submission id could not be read). */
  submitted?: boolean;
  submissionId?: number;
}

export interface SubmitOutcome {
  accepted: boolean;
  verdict: string;
  submissionId?: number;
  timeMs?: number;
  memoryKb?: number;
}

interface UserStatusRow {
  id: number;
  verdict?: string;
  passedTestCount?: number;
  timeConsumedMillis?: number;
  memoryConsumedBytes?: number;
  problem?: { contestId?: number; index?: string; name?: string };
}

interface UserStatusPayload {
  status?: string;
  comment?: string;
  result?: UserStatusRow[];
}

/* -------------------------------------------------------------------------- */
/* Verdict formatting                                                         */
/* -------------------------------------------------------------------------- */

const VERDICT_STYLE: Record<string, 'green' | 'red' | 'yellow' | 'magenta' | 'cyan' | 'grey'> = {
  OK: 'green',
  WRONG_ANSWER: 'red',
  TIME_LIMIT_EXCEEDED: 'yellow',
  MEMORY_LIMIT_EXCEEDED: 'yellow',
  RUNTIME_ERROR: 'magenta',
  COMPILATION_ERROR: 'magenta',
  IDLENESS_LIMIT_EXCEEDED: 'yellow',
  PRESENTATION_ERROR: 'red',
  SECURITY_VIOLATED: 'magenta',
  CRASHED: 'magenta',
  REJECTED: 'magenta',
  SKIPPED: 'grey',
  TESTING: 'cyan',
  FAILED: 'red',
  PARTIAL: 'yellow',
};

const VERDICT_LABEL: Record<string, string> = {
  OK: 'ACCEPTED',
  WRONG_ANSWER: 'WRONG ANSWER',
  TIME_LIMIT_EXCEEDED: 'TIME LIMIT EXCEEDED',
  MEMORY_LIMIT_EXCEEDED: 'MEMORY LIMIT EXCEEDED',
  RUNTIME_ERROR: 'RUNTIME ERROR',
  COMPILATION_ERROR: 'COMPILATION ERROR',
  IDLENESS_LIMIT_EXCEEDED: 'IDLENESS LIMIT EXCEEDED',
  PRESENTATION_ERROR: 'PRESENTATION ERROR',
  SECURITY_VIOLATED: 'SECURITY VIOLATED',
  CRASHED: 'CRASHED',
  REJECTED: 'REJECTED',
  SKIPPED: 'SKIPPED',
  TESTING: 'TESTING',
  FAILED: 'FAILED',
};

function humanVerdict(verdict: string | undefined): string {
  if (!verdict) {
    return 'IN QUEUE';
  }
  return VERDICT_LABEL[verdict] ?? verdict.replace(/_/g, ' ');
}

/* -------------------------------------------------------------------------- */
/* Submitter                                                                  */
/* -------------------------------------------------------------------------- */

export class Submitter {
  constructor(
    private readonly browser: CfBrowser,
    private readonly config: () => CfConfig,
    private readonly runner: () => Runner,
  ) {}

  private log(
    line: string,
    style: 'plain' | 'grey' | 'red' | 'green' | 'yellow' | 'cyan' | 'magenta' | 'bold' = 'plain',
  ): void {
    this.runner().writeLine(line, style);
  }

  /** Full submit flow: open the form, fill it, submit, then poll the verdict API. */
  async submit(request: SubmitRequest): Promise<SubmitOutcome> {
    const cfg = this.config();
    if (!cfg.handle) {
      void vscode.window.showWarningMessage(
        'Set `cfVscode.handle` so the extension can poll the verdict for this submission.',
      );
    }

    const runner = this.runner();
    if (!runner.acquire()) {
      void vscode.window.showWarningMessage('CF Runner is busy (a test batch or submission is in progress).');
      return { accepted: false, verdict: 'BUSY' };
    }

    runner.show();
    this.log('', 'plain');
    this.log(`Submitting ${request.contestId}/${request.index} (${path.basename(request.file)})`, 'bold');

    try {
      const baselineId = await this.latestSubmissionId(cfg.handle).catch(() => undefined);
      const submissionId = await this.postSubmission(request, cfg);

      if (submissionId === undefined) {
        this.log('Submission POST returned, but acceptance was not confirmed. Check Codeforces My Submissions.', 'yellow');
      } else {
        this.log(`Submission #${submissionId} received.`, 'grey');
      }

      if (!cfg.handle) {
        this.log('No handle configured: open Codeforces to follow the verdict manually.', 'yellow');
        return { accepted: false, verdict: 'UNKNOWN', submissionId };
      }

      if (submissionId === undefined && baselineId === undefined) {
        this.log('Cannot identify the new submission safely. Check Codeforces My Submissions.', 'yellow');
        return { accepted: false, verdict: 'UNKNOWN' };
      }
      const outcome = await this.pollVerdict(cfg.handle, request, submissionId, baselineId);
      this.reportOutcome(outcome);
      return outcome;
    } catch (error) {
      this.log(`Submit failed: ${error instanceof Error ? error.message : String(error)}`, 'red');
      void vscode.window.showErrorMessage(
        `CF submit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { accepted: false, verdict: 'ERROR' };
    } finally {
      runner.release();
    }
  }

  /* --------------------------- browser automation -------------------------- */

  private async fillAndSubmit(
    context: BrowserContext,
    request: SubmitRequest,
    cfg: CfConfig,
    mode: 'headless' | 'headed',
  ): Promise<AttemptResult> {
    const page = context.pages()[0] ?? (await context.newPage());
    const url = SUBMIT_URL(request.kind, request.contestId);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (await CfBrowser.isChallenge(page)) {
      if (mode === 'headless') {
        // Signal the caller to re-run this exact page in a visible window.
        return { challenged: true };
      }
      this.log('Waiting for the Cloudflare challenge to be solved in the Chrome window...', 'yellow');
      const cleared = await Submitter.waitForChallenge(page, CHALLENGE_TIMEOUT_MS);
      if (!cleared) {
        throw new Error('The Cloudflare challenge was not solved in time.');
      }
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      this.log('Challenge cleared, continuing the submission.', 'grey');
    }

    // Already logged out: bounce to the login page and let the caller escalate to headed mode.
    if ((await page.locator('form[action*="/enter"]').count()) > 0 && (await page.locator('#sourceCode').count()) === 0) {
      throw new Error('The Codeforces session is not signed in. Run "CF: Login / Refresh Session" first.');
    }

    await page.waitForSelector('#sourceCode', { timeout: 25_000 });

    // Select the problem radio button matching the requested index.
    const problemRadio = page.locator(`input[name="submittedProblemIndex"][value="${request.index}"], input[name="submittedProblemIndex"][value="${request.index.toUpperCase()}"]`).first();
    if ((await problemRadio.count()) > 0) {
      await problemRadio.check({ force: true });
    } else if ((await page.locator('select[name="submittedProblemIndex"]').count()) > 0) {
      await page.selectOption('select[name="submittedProblemIndex"]', request.index);
    } else {
      throw new Error(
        `Problem ${request.index} is not part of contest ${request.contestId}, or the contest is not open for submissions.`,
      );
    }

    // Language / programTypeId.
    const languageSelect = page.locator('select[name="programTypeId"]').first();
    if ((await languageSelect.count()) > 0) {
      const wanted = cfg.cfCompilerId;
      const options = await languageSelect.locator('option').evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: (node as { value?: string }).value ?? '',
          label: node.textContent ?? '',
        })),
      );
      const match = options.find((option) => option.value === wanted);
      if (!match) {
        const available = options
          .slice(0, 12)
          .map((option) => `${option.value} = ${option.label.trim()}`)
          .join('\n');
        throw new Error(
          `cfVscode.cfCompilerId "${wanted}" is not offered by Codeforces right now. Available ids include:\n${available}`,
        );
      }
      await languageSelect.selectOption(wanted);
      this.log(`Language: ${match.label.trim()} (${wanted})`, 'grey');
    } else {
      throw new Error('The language selector is missing; submission stopped rather than using an unknown language.');
    }

    // Paste the source.
    const source = await vscode.workspace.fs.readFile(vscode.Uri.file(request.file));
    const sourceText = Buffer.from(source).toString('utf8');
    const textarea = page.locator('#sourceCode').first();
    await textarea.click({ timeout: 10_000 }).catch(() => undefined);
    await textarea.fill(sourceText);
    const filled = await textarea.inputValue();
    if (filled.trim() !== sourceText.trim()) {
      throw new Error('The Codeforces editor did not accept the full source code.');
    }

    // Turnstile widget: wait for it if the token is not ready yet.
    const turnstileToken = page.locator('input[name="cf-turnstile-response"]');
    if ((await turnstileToken.count()) > 0) {
      this.log('Waiting for the Cloudflare Turnstile token...', 'grey');
      try {
        await page.waitForFunction(
          () => {
            const input = (globalThis as unknown as { document?: { querySelector(selector: string): { value?: string } | null } }).document?.querySelector('input[name="cf-turnstile-response"]');
            return !input || String(input.value ?? '').length > 0;
          }, undefined, { timeout: mode === 'headless' ? 20_000 : CHALLENGE_TIMEOUT_MS },
        );
      } catch {
        if (mode === 'headless') { return { challenged: true }; }
        throw new Error('Turnstile was not completed. No submission was sent.');
      }
    }

    const submitButton = page.locator('#singlePageSubmitButton, input[value="Submit"], button[type="submit"]').first();
    if ((await submitButton.count()) === 0) {
      throw new Error('The Codeforces submit form has no submit button; the page layout may have changed.');
    }

    // Once click is attempted the result can be ambiguous, even if no response arrives.
    // Never automatically retry from this point: the server may have accepted the POST.
    const responsePromise = page.waitForResponse(
      (response) => /\/submit\b/i.test(response.url()) && response.request().method() === 'POST',
      { timeout: 30_000 },
    ).catch(() => undefined);
    try {
      await submitButton.click({ timeout: 20_000 });
    } catch (error) {
      throw new Error(`Submission status is uncertain after clicking Submit. Check Codeforces My Submissions before retrying. ${error instanceof Error ? error.message : String(error)}`);
    }
    const response = await responsePromise;
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    if (!response || !response.ok() || await CfBrowser.isChallenge(page)) {
      throw new Error('Submission status is uncertain after clicking Submit. Check Codeforces My Submissions before retrying.');
    }
    await Submitter.checkRejection(page);
    if (await page.locator('#sourceCode').count()) {
      throw new Error('The submit form is still open. Submission status is uncertain; check Codeforces My Submissions before retrying.');
    }
    // A status table may contain old rows. Only a submission-specific URL is authoritative.
    const submissionId = await Submitter.readSubmissionId(page);
    return { submitted: true, submissionId };
  }

  /** Polls a visible page until Cloudflare stops challenging it, or the window closes. */
  private static async waitForChallenge(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        return false;
      }
      if (!(await CfBrowser.isChallenge(page))) {
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  /** Check form errors before treating a POST response as success. */
  private static async checkRejection(page: Page): Promise<void> {
    const bodyText = await page.locator('body').innerText();
    const message = /(You have submitted exactly the same code before|Daily submission limit|need to be registered|not allowed)/i.exec(bodyText)?.[0];
    if (message) { throw new Error(`Codeforces rejected the submission: ${message}`); }
    const errors = await page.locator('.error, .error-message, .errorMessage').allTextContents();
    const visible = errors.map((text) => text.trim()).filter(Boolean);
    if (visible.length) { throw new Error(`Codeforces rejected the submission: ${visible.join('; ')}`); }
  }

  private static async readSubmissionId(page: Page): Promise<number | undefined> {
    const match = /\/submission\/(\d+)(?:[/?#]|$)/.exec(page.url());
    return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
  }

  /**
   * Posts the submission, escalating to a visible window when Cloudflare intercepts.
   *
   * The form is only retried when the previous pass was stopped *before* the POST went out
   * (a challenge), never after a POST, so a submission cannot be duplicated.
   */
  private async postSubmission(request: SubmitRequest, cfg: CfConfig): Promise<number | undefined> {
    const attempt = async (mode: 'headless' | 'headed'): Promise<AttemptResult> =>
      this.browser.run(mode, cfg, async (context) => this.fillAndSubmit(context, request, cfg, mode));

    const first = await attempt('headless');
    if (first.submitted) {
      return first.submissionId;
    }

    if (!first.challenged) { throw new Error('Submission was not confirmed. Check Codeforces My Submissions before retrying.'); }
    this.log('Cloudflare Turnstile blocked the headless attempt.', 'yellow');
    this.log('Re-opening the submit page in a visible Chrome window...', 'grey');
    void vscode.window.showInformationMessage(
      'Codeforces needs a Cloudflare check. The submit page is open in Chrome - solve the check and the submission continues automatically.',
    );

    // Solve the interstitial once in the visible window; the cookies it sets (cf_clearance)
    // are written to the persistent profile, so later submissions stay headless.
    const cleared = await this.browser.resolveChallenge(
      cfg,
      SUBMIT_URL(request.kind, request.contestId),
      (message) => this.log(message, 'grey'),
    );
    if (!cleared) {
      throw new Error('The Cloudflare challenge was not cleared in time; nothing was submitted.');
    }

    const escalated = await attempt('headed');
    if (escalated.submitted) {
      this.log('Submission POST returned from the visible window.', 'grey');
      return escalated.submissionId;
    }
    if (escalated.challenged) {
      throw new Error('The Cloudflare challenge was not cleared in time; nothing was submitted.');
    }
    throw new Error('The submission could not be posted; nothing was submitted.');
  }

  /* ----------------------------- verdict poll ------------------------------ */

  private async latestSubmissionId(handle: string): Promise<number | undefined> {
    if (!handle) {
      return undefined;
    }
    const payload = await this.fetchUserStatus(handle, 20);
    return payload.result?.[0]?.id;
  }

  private async fetchUserStatus(handle: string, count: number): Promise<UserStatusPayload> {
    const url =
      `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}` +
      `&from=1&count=${count}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'cf-vscode/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from user.status`);
    }
    const payload = (await response.json()) as UserStatusPayload;
    if (payload.status !== 'OK') {
      throw new Error(payload.comment ?? 'user.status returned a failure');
    }
    return payload;
  }

  /** Matches the new row for our problem, tolerating the 1-2s API indexing delay. */
  private findRow(
    rows: UserStatusRow[] | undefined,
    request: SubmitRequest,
    submissionId: number | undefined,
    baselineId: number | undefined,
  ): UserStatusRow | undefined {
    if (!rows) {
      return undefined;
    }
    if (submissionId !== undefined) { return rows.find((row) => row.id === submissionId); }
    if (baselineId === undefined) { return undefined; }
    return rows.find(
      (row) =>
        row.problem?.index?.toUpperCase() === request.index.toUpperCase() &&
        String(row.problem?.contestId) === request.contestId &&
        row.id > baselineId,
    );
  }

  private async pollVerdict(
    handle: string,
    request: SubmitRequest,
    submissionId: number | undefined,
    baselineId: number | undefined,
  ): Promise<SubmitOutcome> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let lastLine = '';
    let polls = 0;

    while (Date.now() < deadline) {
      polls += 1;
      try {
        const payload = await this.fetchUserStatus(handle, 10);
        const row = this.findRow(payload.result, request, submissionId, baselineId);
        if (row) {
          const verdict = row.verdict ?? 'TESTING';
          const line =
            verdict === 'TESTING'
              ? `Testing on test ${(row.passedTestCount ?? 0) + 1}`
              : humanVerdict(row.verdict);
          if (line !== lastLine) {
            const style = VERDICT_STYLE[verdict] ?? 'grey';
            this.log(`  ${line}`, style);
            lastLine = line;
          }
          if (verdict !== 'TESTING' && row.verdict) {
            return {
              accepted: verdict === 'OK',
              verdict,
              submissionId: row.id,
              timeMs: row.timeConsumedMillis,
              memoryKb:
                row.memoryConsumedBytes !== undefined ? Math.round(row.memoryConsumedBytes / 1024) : undefined,
            };
          }
        } else if (polls === 1) {
          this.log('  In queue', 'cyan');
          lastLine = 'In queue';
        }
      } catch (error) {
        // Transient API hiccups (rate limit) should not abort the poll.
        if (polls % 5 === 0) {
          this.log(`  poll retry (${error instanceof Error ? error.message : String(error)})`, 'grey');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    this.log('  Verdict not available after 60 s. Check the Codeforces status page.', 'yellow');
    return { accepted: false, verdict: 'TIMEOUT', submissionId };
  }

  private reportOutcome(outcome: SubmitOutcome): void {
    const label = humanVerdict(outcome.verdict);
    const style = VERDICT_STYLE[outcome.verdict] ?? 'grey';
    this.log('', 'plain');
    this.log(`  ${label}`, style);
    if (outcome.timeMs !== undefined || outcome.memoryKb !== undefined) {
      const parts: string[] = [];
      if (outcome.timeMs !== undefined) {
        parts.push(`${outcome.timeMs} ms`);
      }
      if (outcome.memoryKb !== undefined) {
        parts.push(`${outcome.memoryKb} KB`);
      }
      this.log(`  ${parts.join('  /  ')}`, 'grey');
    }
    if (outcome.verdict === 'COMPILATION_ERROR') {
      this.log('  Open the submission on Codeforces for the full compiler output.', 'grey');
    }
  }
}
