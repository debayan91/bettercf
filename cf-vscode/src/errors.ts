/**
 * Structured, user-facing failures.
 *
 * Every command in the extension funnels through `toCfError`, so a coder never sees a raw
 * Playwright or Node message when there is a known failure. Each error carries a stable code,
 * a human message, and optional technical detail for the log channel.
 */

export type CfErrorCode =
  | 'NO_WORKSPACE'
  | 'CHROME_MISSING'
  | 'BROWSER_LAUNCH'
  | 'CLOUDFLARE'
  | 'NOT_LOGGED_IN'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'COMPILE'
  | 'COMPILER_MISSING'
  | 'NO_TESTS'
  | 'TEMPLATE_MISSING'
  | 'BUSY'
  | 'CANCELLED'
  | 'UNKNOWN';

/** An error with a stable code and diagnostic detail. */
export class CfError extends Error {
  constructor(
    readonly code: CfErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'CfError';
  }
}

export function isCfError(error: unknown): error is CfError {
  return error instanceof CfError;
}

const NETWORK_PATTERNS = [
  /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT)|NETWORK_CHANGED)/i,
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i,
  /fetch failed|network/i,
];

const LAUNCH_PATTERNS = [
  /ProcessSingleton|SingletonLock|profile.*in use/i,
  /Target page, context or browser has been closed/i,
  /Failed to launch|browserType\.launch/i,
  /spawn .*ENOENT/i,
];

/** Normalises anything thrown into a `CfError` with a readable message. */
export function toCfError(error: unknown): CfError {
  if (isCfError(error)) {
    return error;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  if (/codeforces\.com.*(404|not found)|did not contain a statement/i.test(raw)) {
    return new CfError(
      'NOT_FOUND',
      'That problem page does not exist, or it is not visible to your account.',
      raw,
    );
  }
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(raw))) {
    return new CfError(
      'NETWORK',
      'Could not reach codeforces.com. Check your connection, VPN or proxy and retry.',
      raw,
    );
  }
  if (LAUNCH_PATTERNS.some((pattern) => pattern.test(raw))) {
    return new CfError('BROWSER_LAUNCH', 'The browser could not be started.', raw);
  }
  if (/ENOENT.*(g\+\+|clang|gcc)/i.test(raw) || /spawn (g\+\+|clang\+\+).*ENOENT/i.test(raw)) {
    return new CfError('COMPILER_MISSING', 'No C++ compiler was found on your PATH.', raw);
  }
  return new CfError('UNKNOWN', raw, stack);
}

