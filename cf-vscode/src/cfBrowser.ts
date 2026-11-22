import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BrowserContext, Cookie, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import * as vscode from 'vscode';

import { CfConfig } from './config';

export type BrowserMode = 'headless' | 'headed';

/** Result of probing the persisted profile for a signed-in Codeforces session. */
export interface SessionValidation {
  signedIn: boolean;
  handle?: string;
}

const CLOUDFLARE_TITLE_MARKERS = ['just a moment', 'attention required', 'checking your browser'];
const NAV_TIMEOUT_MS = 45_000;
const CHALLENGE_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 30 * 60 * 1000;

/** Minimal logger so the browser layer can stream progress into the runner terminal. */
export interface BrowserLog {
  (message: string): void;
}

/**
 * Owns the single persistent Chrome profile used for every Codeforces interaction.
 *
 * `playwright-core` drives the user's own Chrome binary through `launchPersistentContext`,
 * so cookies (including Cloudflare `cf_clearance`) survive across restarts. Only one context
 * may exist at any moment: Chrome locks a user-data-dir, and two concurrent launches produce
 * `ProcessSingleton` failures. Every public entry point therefore funnels through `run()`.
 */
export class CfBrowser {
  private context: BrowserContext | null = null;
  private contextMode: BrowserMode | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly log: BrowserLog,
  ) {}

  /** Persistent Chrome profile directory inside the extension's global storage. */
  get profileDir(): string {
    return path.join(this.storageUri.fsPath, 'chrome-profile');
  }

  /** Absolute path to the Chrome binary that will be driven. */
  private chromePath(cfg: CfConfig): string {
    const configured = cfg.chromePath;
    if (!configured) {
      throw new Error(
        'cfVscode.chromePath is empty. Set it to your Google Chrome executable (Settings > Extensions > CF).',
      );
    }
    try {
      fs.accessSync(configured, fs.constants.X_OK);
    } catch {
      throw new Error(
        `Google Chrome was not found or is not executable at:\n${configured}\n` +
          'Update `cfVscode.chromePath` in Settings to point at your Chrome binary.',
      );
    }
    return configured;
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
          '#challenge-running, #challenge-stage, iframe[src*="challenges.cloudflare.com"], .cf-turnstile, #cf-turnstile',
        )
        .first()
        .count()
        .catch(() => 0);
      return marker > 0;
    } catch {
      return false;
    }
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
    const executablePath = this.chromePath(cfg);
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
        executablePath,
        headless: mode === 'headless',
        viewport: mode === 'headless' ? { width: 1440, height: 900 } : null,
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        args,
      });

    try {
      return await attempt();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ProcessSingleton|SingletonLock|already in use|user data directory is already in use/i.test(message)) {
        throw error;
      }
      this.log('Chrome profile lock detected, clearing stale lock files...');
      await CfBrowser.clearSingletonFiles(this.profileDir);
      await new Promise((resolve) => setTimeout(resolve, 750));
      return attempt();
    }
  }

  private static async clearSingletonFiles(profileDir: string): Promise<void> {
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      await fsp.rm(path.join(profileDir, name), { force: true, recursive: false }).catch(() => undefined);
    }
  }

  private async ensure(mode: BrowserMode, cfg: CfConfig): Promise<BrowserContext> {
    if (this.context && this.contextMode === mode && this.context.pages().length >= 0) {
      try {
        // Cheap liveness probe: touching pages throws once the browser is gone.
        this.context.pages();
        return this.context;
      } catch {
        this.context = null;
        this.contextMode = null;
      }
    }
    await this.closeContext();
    this.log(mode === 'headless' ? 'Starting Chrome (headless)...' : 'Starting Chrome (visible)...');
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
    this.context = null;
    this.contextMode = null;
    if (!context) {
      return;
    }
    try {
      await context.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * Runs `fn` with exclusive access to a persistent context of the requested mode.
   * The lock is held for the whole callback, which lets callers escalate to a visible
   * window mid-flow without risking a second Chrome instance.
   */
  async run<T>(mode: BrowserMode, cfg: CfConfig, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
    if (this.disposed) {
      throw new Error('The Chrome session is shutting down. Re-run the command.');
    }
    const release = await this.acquire();
    try {
      let context = await this.ensure(mode, cfg);
      try {
        return await fn(context);
      } catch (error) {
        if (this.isClosedError(error)) {
          this.context = null;
          this.contextMode = null;
          context = await this.ensure(mode, cfg);
          return await fn(context);
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  private isClosedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /Target page, context or browser has been closed|browser has been closed|Protocol error/i.test(message);
  }

  /** Opens a URL in a visible window and resolves once the user closes it. */
  async openForLogin(cfg: CfConfig, url: string): Promise<void> {
    const release = await this.acquire();
    try {
      await this.closeContext();
      const context = await this.ensure('headed', cfg);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
      page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
      this.log('Chrome is open. Log in to Codeforces, then close the window to save the session.');
      await CfBrowser.waitForWindowClose(context, page, LOGIN_TIMEOUT_MS);
      await this.closeContext();
      this.log('Chrome closed: session cookies written to the extension profile.');
    } finally {
      release();
    }
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
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
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

  /** Waits for the user to close the visible Chrome window. */
  private static async waitForWindowClose(
    context: BrowserContext,
    page: Page,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          context.off('close', finish);
          resolve();
        }
      };
      context.on('close', finish);
      const poll = async (): Promise<void> => {
        while (!done && Date.now() < deadline) {
          if (page.isClosed() || context.pages().length === 0) {
            finish();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        finish();
      };
      void poll();
    });
  }

  /** Returns true when the persistent profile still holds a logged-in Codeforces session. */
  async validateSession(cfg: CfConfig): Promise<SessionValidation> {
    return this.run('headless', cfg, async (context) => {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto('https://codeforces.com/', { waitUntil: 'domcontentloaded' });
      if (await CfBrowser.isChallenge(page)) {
        return { signedIn: false };
      }
      const logout = await page.locator('a[href*="/logout"]').count();
      let handle: string | undefined;
      const profileLink = page.locator('a[href^="/profile/"]').first();
      if ((await profileLink.count()) > 0) {
        const href = await profileLink.getAttribute('href');
        if (href) {
          handle = href.replace('/profile/', '').trim() || undefined;
        }
      }
      return { signedIn: logout > 0, handle };
    });
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
