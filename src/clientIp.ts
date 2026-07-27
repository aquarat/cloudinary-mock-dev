import type { Context } from "hono";

/**
 * Behind Cloudflare, `CF-Connecting-IP` is the real client address (Cloudflare
 * sets it itself, so it can't be spoofed by the client through the proxy).
 * `X-Forwarded-For`'s first hop is a fallback for other reverse proxies;
 * neither is present for direct/local requests.
 */
export function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf;
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}
