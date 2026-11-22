import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BrowserContext, Cookie, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import * as vscode from 'vscode';

import { CfConfig } from './config';
import { detectChrome } from './environment';
import { CfError } from './errors';

export type BrowserMode = 'headless' | 'headed';

const CLOUDFLARE_TITLE_MARKERS = ['just a moment', 'attention required', 'checking your browser'];
const NAV_TIMEOUT_MS = 45_000;
const CHALLENGE_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 30 * 60 * 1000;
const CF_HOME = 'https://codeforces.com/';

/** Result of probing the persisted profile for a signed-in Codeforces session. */
export interface SessionValidation {
  state: 'signed-in' | 'signed-out' | 'challenged' | 'network-error' | 'unknown';
  signedIn: boolean;
  handle?: string;
  /** Human explanation when `state` is not `signed-in`. */
  message: string;
  detail?: string;
}

export interface LoginResult extends SessionValidation {
  /** Chrome was driven to completion; the profile is on disk. */
  profileSaved: boolean;
}

/** Minimal logger so the browser layer can stream progress into the runner terminal. */
export interface BrowserLog {
  (message: string): void;
}

/**
 * Owns the single persistent Chrome profile used for every Codeforces interaction.
 *
 * `playwright-core` drives the user's own Chrome binary through `launchPersistentContext`, so
 * cookies (including Cloudflare `cf_clearance`) survive across restarts. Only one context may
 * exist at any moment: Chrome locks a user-data-dir, and two concurrent launches produce
 * `ProcessSingleton` failures. Every public entry point therefore funnels through `run()`.
 */
export class CfBrowser {
  private context: BrowserContext | null = null;
  private contextMode: BrowserMode | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /** Cached "how do we launch" decision, so we do not re-detect Chrome on every request. */
  private launchPlan: { executablePath?: string; channel?: string; reason: string } | null = null;
  private planConfiguredPath = '';

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly log: BrowserLog,
  ) {}

  /** Persistent Chrome profile directory inside the extension's global storage. */
  get profileDir(): string {
    return path.join(this.storageUri.fsPath, 'chrome-profile');
  }

  /** Resolves the binary/channel to launch, or throws a user-actionable error. */
  private async resolveLaunchTarget(cfg: CfConfig): Promise<{ executablePath?: string; channel?: string; reason: string }> {
    if (this.launchPlan && this.planConfiguredPath === cfg.chromePath) {
      return this.launchPlan;
    }
    this.launchPlan = null;
    this.planConfiguredPath = cfg.chromePath;
    const detected = await detectChrome(cfg.chromePath);
    if (detected) {
      this.launchPlan = { executablePath: detected.path, reason: `detected Chrome (${detected.source})` };
      if (detected.path !== cfg.chromePath) {
        this.log(`Using Chrome at ${detected.path}`);
      }
      return this.launchPlan;
    }
    throw new CfError(
      'CHROME_MISSING',
      'No Chrome, Edge or Chromium installation was found. Install Chrome or set cfVscode.chromePath.',
    );
  }

  /** Forgets a failed launch decision so the next attempt re-probes the machine. */
  private invalidatePlan(): void {
    this.launchPlan = null;
  }

  /** True when the page is showing a Cloudflare interstitial / Turnstile challenge. */
  static async isChallenge(page: Page): Promise<boolean> {
    try {
      const title = (await page.title()).toLowerCase();
      if (CLOUDFLARE_TITLE_MARKERS.some((marker) => title.includes(marker))) {
        return true;
      }
      const url = page.url().toLowerCase();
      if (url.includes('/cdn-cgi/') || url.includes('challenges.cloudflare.com')) {
        return true;
      }
      const marker = await page
        .locator(
          '#challenge-running, #challenge-stage, #challenge-form',
        )
        .first()
        .count()
        .catch(() => 0);
      return marker > 0;
    } catch {
      return false;
    }
  }

  /** Detects the "signed in" state of a loaded Codeforces page. */
  private static async readSession(page: Page): Promise<{ signedIn: boolean; handle?: string }> {
    const logout = await page.locator('a[href*="/logout"]').count().catch(() => 0);
    let handle: string | undefined;
    const profileLink = page.locator('#header a[href^="/profile/"]').first();
    if ((await profileLink.count().catch(() => 0)) > 0) {
      const href = await profileLink.getAttribute('href').catch(() => null);
      if (href) {
        handle = href.replace('/profile/', '').trim() || undefined;
      }
    }
    return { signedIn: logout > 0, handle };
  }

  /** Serialises work so a second caller can never race the Chrome profile lock. */
  private async acquire(): Promise<() => void> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    return release;
  }

  private async launch(mode: BrowserMode, cfg: CfConfig): Promise<BrowserContext> {
    const target = await this.resolveLaunchTarget(cfg);
    await fsp.mkdir(this.profileDir, { recursive: true });
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ];

    const attempt = async (): Promise<BrowserContext> =>
      chromium.launchPersistentContext(this.profileDir, {
        ...(target.executablePath ? { executablePath: target.executablePath } : {}),
        ...(target.channel ? { channel: target.channel } : {}),
        headless: mode === 'headless',
        viewport: mode === 'headless' ? { width: 1440, height: 900 } : null,
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        args,
      });

    try {
      this.log(`Launching ${target.reason} (${mode})...`);
      return await attempt();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.invalidatePlan();
      throw new CfError(
        'BROWSER_LAUNCH',
        `Could not start the browser (${target.reason}). Run "CF: Doctor" to check your setup.`,
        message,
      );
    }
  }

  private async ensure(mode: BrowserMode, cfg: CfConfig): Promise<BrowserContext> {
    if (this.context && this.contextMode === mode) {
      try {
        this.context.pages();
        return this.context;
      } catch {
        this.context = null;
        this.contextMode = null;
      }
    }
    await this.closeContext();
    const context = await this.launch(mode, cfg);
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    context.on('close', () => {
      if (this.context === context) {
        this.context = null;
        this.contextMode = null;
      }
    });
    this.context = context;
    this.contextMode = mode;
    return context;
  }

  private async closeContext(): Promise<void> {
    const context = this.context;
    if (!context) {
      return;
    }
    try {
      await context.close();
      if (this.context === context) { this.context = null; this.contextMode = null; }
    } catch (error) {
      throw new CfError('BROWSER_LAUNCH', 'Could not close the previous browser safely. Close Chrome for the Codeforces profile and retry.', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Runs `fn` with exclusive access to a persistent context of the requested mode.
   * The lock is held for the whole callback, which lets callers escalate to a visible
   * window mid-flow without risking a second Chrome instance.
   */
  async run<T>(mode: BrowserMode, cfg: CfConfig, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
    if (this.disposed) {
      throw new CfError('CANCELLED', 'The browser session is shutting down. Re-run the command.');
    }
    const release = await this.acquire();
    try {
      if (this.disposed) { throw new CfError('CANCELLED', 'The browser session is shutting down.'); }
      const context = await this.ensure(mode, cfg);
      return await fn(context);
    } finally {
      release();
    }
  }

  /* ------------------------------- login flow ------------------------------ */

  /**
   * Opens Codeforces in a visible window and *validates inside that same window*.
   *
   * The previous implementation closed the window and then re-checked in a fresh headless
   * browser, which fails whenever Cloudflare challenges the headless user-agent — reporting a
   * successful login as a failure. Here the verification happens before teardown, on the very
   * page the user just used, so the result reflects reality.
   */
  async login(cfg: CfConfig, log: BrowserLog): Promise<LoginResult> {
    const release = await this.acquire();
    try {
      await this.closeContext();
      const context = await this.ensure('headed', cfg);
      const page = context.pages()[0] ?? (await context.newPage());
      page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));

      try {
        await page.goto('https://codeforces.com/enter', {
          waitUntil: 'domcontentloaded',
          timeout: NAV_TIMEOUT_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CfError('NETWORK', 'Could not open codeforces.com. Check your connection and retry.', message);
      }

      log('Chrome is open. Log in to Codeforces; the window closes itself once it detects your session.');

      const validation = await this.watchForLogin(context, page, log);
      // Cookies are flushed to disk on close; do this explicitly so the next headless request
      // reuses the session immediately.
      await this.closeContext();
      return { ...validation, profileSaved: true };
    } finally {
      await this.closeContext();
      release();
    }
  }

  /**
   * Polls the live page (and any new tabs) for a signed-in session. Resolves as soon as the
   * session appears, so the user never has to know that closing the window is the trigger.
   */
  private async watchForLogin(
    context: BrowserContext,
    initialPage: Page,
    log: BrowserLog,
  ): Promise<SessionValidation> {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let lastNote = '';
    let sawChallenge = false;

    while (Date.now() < deadline) {
      if (context.pages().length === 0) {
        return {
          state: 'signed-out',
          signedIn: false,
          message: 'The Chrome window was closed before a session was detected.',
        };
      }

      const pages = context.pages().filter((candidate) => !candidate.isClosed());
      const page = pages.includes(initialPage) ? initialPage : pages[0];
      if (!page) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      try {
        const challenged = await CfBrowser.isChallenge(page);
        if (challenged) {
          sawChallenge = true;
          if (lastNote !== 'challenge') {
            log('Cloudflare is checking the browser. Complete the check if it appears; the session is saved automatically.');
            lastNote = 'challenge';
          }
        } else {
          const session = await CfBrowser.readSession(page);
          if (session.signedIn) {
            return {
              state: 'signed-in',
              signedIn: true,
              ...(session.handle ? { handle: session.handle } : {}),
              message: session.handle ? `Signed in as ${session.handle}.` : 'Signed in.',
            };
          }
          if (lastNote !== 'waiting') {
            log('Waiting for you to sign in (the window closes by itself afterwards)...');
            lastNote = 'waiting';
          }
        }
      } catch {
        /* page navigating: try again */
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    return {
      state: sawChallenge ? 'challenged' : 'unknown',
      signedIn: false,
      message: sawChallenge
        ? 'Cloudflare never let the page through. Try again, or open codeforces.com in your own browser first.'
        : 'The login window timed out after 30 minutes.',
    };
  }

  /**
   * Navigates a visible window to `url` and blocks until the Cloudflare challenge is
   * cleared (or the user closes the window).
   */
  async resolveChallenge(cfg: CfConfig, url: string, log: BrowserLog): Promise<boolean> {
    const release = await this.acquire();
    try {
      await this.closeContext();
      const context = await this.ensure('headed', cfg);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      log('Cloudflare challenge detected. Solve it in the Chrome window that just opened.');
      const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
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
    } finally {
      release();
    }
  }

  /* ----------------------------- validation -------------------------------- */

  /**
   * Probes the persisted profile. A Cloudflare challenge is reported as `challenged`, never as
   * "signed out", so the UI can offer the right next step.
   */
  async validateSession(cfg: CfConfig): Promise<SessionValidation> {
    try {
      return await this.run('headless', cfg, async (context) => {
        const page = context.pages()[0] ?? (await context.newPage());
        try {
          await page.goto(CF_HOME, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        } catch (error) {
          return {
            state: 'network-error' as const,
            signedIn: false,
            message: 'Could not reach codeforces.com.',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        if (await CfBrowser.isChallenge(page)) {
          return {
            state: 'challenged' as const,
            signedIn: false,
            message: 'Cloudflare is challenging headless requests right now.',
          };
        }
        const session = await CfBrowser.readSession(page);
        return {
          state: session.signedIn ? ('signed-in' as const) : ('signed-out' as const),
          signedIn: session.signedIn,
          ...(session.handle ? { handle: session.handle } : {}),
          message: session.signedIn
            ? session.handle
              ? `Signed in as ${session.handle}.`
              : 'Signed in.'
            : 'No Codeforces session in the saved profile.',
        };
      });
    } catch (error) {
      const cfError = error instanceof CfError ? error : null;
      return {
        state: 'unknown',
        signedIn: false,
        message: cfError?.message ?? 'Could not verify the session.',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Reads the cookies currently stored in the persistent profile. */
  async cookies(): Promise<Cookie[]> {
    if (!this.context) {
      return [];
    }
    try {
      return await this.context.cookies();
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const release = await this.acquire();
    try {
      await this.closeContext();
    } finally {
      release();
    }
  }
}
