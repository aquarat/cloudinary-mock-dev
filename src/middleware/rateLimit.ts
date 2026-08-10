import type { Context, MiddlewareHandler } from "hono";
import { clientIp } from "../clientIp";
import { log } from "../logger";
import { getRequestId } from "../requestContext";

/**
 * A dependency-free, in-memory fixed-window rate limiter — a first line of
 * defence against brute-force signature guessing and upload floods. Counts are
 * per client IP (via `clientIp`), so a single instance is protected; it is not
 * a distributed limiter and does not survive a restart.
 *
 * Configured once at module load from the environment:
 *   RATE_LIMIT_MAX        max requests per window (default 120). 0 disables it.
 *   RATE_LIMIT_WINDOW_MS  window length in ms (default 60000).
 */
const MAX = readIntEnv("RATE_LIMIT_MAX", 120);
const WINDOW_MS = readIntEnv("RATE_LIMIT_WINDOW_MS", 60_000);

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

interface Window {
  /** Requests seen so far in the current window. */
  count: number;
  /** Epoch ms at which the current window expires and the count resets. */
  resetAt: number;
}

const windows = new Map<string, Window>();

// Sweep expired windows periodically so the map can't grow unbounded from a
// churn of one-off IPs. `.unref()` keeps this timer from holding the process
// open during shutdown. Lazy resets below handle correctness; this is cleanup.
if (MAX > 0) {
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of windows) {
      if (now >= window.resetAt) windows.delete(key);
    }
  }, WINDOW_MS);
  sweep.unref();
}

export interface RateLimitOptions {
  /**
   * Requests for which this returns true bypass the limiter entirely. Used to
   * exempt a signed-in admin: browsing the asset table fires one API call plus
   * a thumbnail request per row, which legitimately outruns a limit sized for
   * anonymous traffic. The predicate must *verify* the caller's session rather
   * than trust a header, or the exemption becomes a free bypass.
   */
  isExempt?: (c: Context) => boolean | Promise<boolean>;
}

/**
 * Builds the limiter middleware. A max of 0 (or any disabling value)
 * short-circuits to a pass-through so it can be turned off via the environment.
 */
export function createRateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const { isExempt } = options;

  if (MAX <= 0) {
    return async (_c, next) => {
      await next();
    };
  }

  return async (c, next) => {
    if (isExempt && (await isExempt(c))) return next();

    const key = clientIp(c);
    const now = Date.now();
    const window = windows.get(key);

    if (!window || now >= window.resetAt) {
      // Start (or lazily reset) this key's window.
      windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return next();
    }

    window.count += 1;
    if (window.count > MAX) {
      const retryAfterSec = Math.ceil((window.resetAt - now) / 1000);
      log.warn("rate_limit", {
        req_id: getRequestId(c),
        ip: key,
        count: window.count,
        limit: MAX,
      });
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: { message: "Rate limit exceeded" } }, 429);
    }

    return next();
  };
}
