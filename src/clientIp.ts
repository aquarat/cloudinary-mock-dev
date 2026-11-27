import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

/**
 * Behind Cloudflare, `CF-Connecting-IP` is the real client address (Cloudflare
 * sets it itself, so it can't be spoofed by the client through the proxy).
 * `X-Forwarded-For`'s first hop is a fallback for other reverse proxies.
 *
 * Direct requests carry neither header, so they are identified by the socket's
 * peer address. Without that every direct caller would share a single key, and
 * with it a single rate-limit bucket.
 */
export function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf;
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return socketAddress(c) ?? "unknown";
}

/** The peer address from Bun's server; undefined when there is no server (e.g. `app.request()` in tests). */
function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}
