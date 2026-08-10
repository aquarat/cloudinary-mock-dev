import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { Config } from "../config";
import { log } from "../logger";

export const ADMIN_JWT_ALG = "HS256";

/**
 * Name of the admin session cookie.
 *
 * IMPORTANT: this cookie is deliberately NOT accepted as authentication for any
 * admin API endpoint — those require the `Authorization: Bearer` header, which
 * a cross-site form or image cannot set. Its one and only purpose is to let the
 * rate limiter recognise a signed-in operator on requests that cannot carry a
 * header: the `<img>` thumbnails the asset table loads from the delivery route.
 * Keeping the cookie powerless for state changes is what keeps CSRF off the
 * table — widening it to authenticate the API would reintroduce that risk.
 */
export const ADMIN_SESSION_COOKIE = "admin_session";
/** Session lifetime. Long enough to work through a tidy-up, short enough to expire the same day. */
export const ADMIN_TOKEN_TTL_SECONDS = 8 * 60 * 60;

/** Index signature keeps this assignable to Hono's `JWTPayload`. */
export interface AdminSessionPayload {
  sub: string;
  exp: number;
  iat: number;
  [claim: string]: unknown;
}

/**
 * Resolves the HMAC secret used to sign admin sessions. `ADMIN_JWT_SECRET` is
 * preferred; without it a fresh random secret is minted per process so tokens
 * are still unforgeable — they just don't survive a restart. There is
 * deliberately no hardcoded fallback: a committed constant would let anyone
 * mint a valid admin session.
 */
export function resolveJwtSecret(config: Config): string {
  if (config.adminJwtSecret && config.adminJwtSecret.trim() !== "") {
    return config.adminJwtSecret;
  }
  log.warn("admin_jwt_secret_generated", {
    hint: "ADMIN_JWT_SECRET is not set — a random secret was generated, so admin sessions will not survive a restart",
  });
  return randomBytes(32).toString("hex");
}

/**
 * Length-safe constant-time comparison (same shape as the one guarding request
 * signatures in src/signature.ts). `timingSafeEqual` throws on differing
 * lengths, and a length mismatch already means "not equal", so the early return
 * leaks nothing beyond the length of the supplied value.
 */
export function constantTimeEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Checks both credentials in constant time. Both comparisons always run (no
 * `&&` short-circuit) so response timing can't reveal whether the username
 * alone was correct — i.e. it can't be used to enumerate the account name.
 */
export function credentialsMatch(config: Config, username: string, password: string): boolean {
  const usernameOk = constantTimeEqual(username, config.adminUsername ?? "");
  const passwordOk = constantTimeEqual(password, config.adminPassword ?? "");
  return usernameOk && passwordOk;
}

export async function issueToken(username: string, secret: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: AdminSessionPayload = {
    sub: username,
    iat: issuedAt,
    exp: issuedAt + ADMIN_TOKEN_TTL_SECONDS,
  };
  return sign(payload, secret, ADMIN_JWT_ALG);
}

function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/** Only mark the cookie `Secure` when the request actually arrived over TLS — a Secure cookie on plain http://localhost is dropped by the browser. */
function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    // Strict: the cookie is never sent from another site, so it cannot be used
    // to piggyback a cross-site request even for the little it permits.
    sameSite: "Strict",
    secure: isSecureRequest(c),
    path: "/",
    maxAge: ADMIN_TOKEN_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, ADMIN_SESSION_COOKIE, { path: "/" });
}

/**
 * True when the request carries a genuinely valid admin session, presented
 * either as a bearer token or as the session cookie. The token is verified, not
 * merely detected — accepting the mere presence of a header or cookie would let
 * anyone opt out of rate limiting by sending an arbitrary value.
 */
export function hasValidAdminSession(secret: string): (c: Context) => Promise<boolean> {
  return async (c) => {
    const token = bearerToken(c) ?? getCookie(c, ADMIN_SESSION_COOKIE);
    if (!token) return false;
    try {
      await verify(token, secret, ADMIN_JWT_ALG);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Gate for every admin data endpoint. Applied with `app.use("/admin/api/*")`
 * and then opted out of for login only, so a newly-added endpoint is protected
 * by default rather than by remembering to guard it.
 */
export function requireAdminToken(secret: string): MiddlewareHandler {
  return async (c, next) => {
    const token = bearerToken(c);
    if (!token) {
      return c.json({ error: { message: "Missing bearer token" } }, 401);
    }
    try {
      await verify(token, secret, ADMIN_JWT_ALG);
    } catch {
      return c.json({ error: { message: "Invalid or expired token" } }, 401);
    }
    await next();
  };
}
