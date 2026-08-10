import { createHash, timingSafeEqual } from "node:crypto";

// Params Cloudinary excludes from the signature payload regardless of the
// request they arrived on. `signature` and `file` never get signed; `api_key`
// is transmitted alongside the signature, not folded into it.
const EXCLUDED_PARAMS = new Set(["signature", "api_key", "file", "cloud_name", "resource_type"]);

export type SignableParams = Record<string, unknown>;

function toSignString(params: SignableParams): string {
  return Object.keys(params)
    .filter((key) => !EXCLUDED_PARAMS.has(key))
    .filter((key) => {
      const value = params[key];
      return value !== undefined && value !== null && value !== "";
    })
    .sort()
    .map((key) => {
      const value = params[key];
      const flat = Array.isArray(value) ? value.join(",") : String(value);
      return `${key}=${flat}`;
    })
    .join("&");
}

/** Matches `Cloudinary::Utils.sign_request` / the JS SDK's `api_sign_request`. */
export function signParams(params: SignableParams, apiSecret: string, algorithm: "sha1" | "sha256" = "sha1"): string {
  const toSign = toSignString(params);
  return createHash(algorithm)
    .update(toSign + apiSecret)
    .digest("hex");
}

/**
 * Cloudinary SDKs have shipped both SHA-1 (long-standing default) and SHA-256
 * signatures depending on version/config. Accepting either keeps this server
 * agnostic to exactly which the calling Ruby/JS SDK build produced.
 */
export function verifySignature(params: SignableParams, providedSignature: string, apiSecret: string): boolean {
  const sha1 = signParams(params, apiSecret, "sha1");
  const sha256 = signParams(params, apiSecret, "sha256");
  // Compare in constant time so the number of matching characters can't be
  // inferred from how long the check takes. OR both results rather than
  // short-circuiting so timing doesn't reveal which algorithm matched.
  const matchesSha1 = constantTimeEqual(providedSignature, sha1);
  const matchesSha256 = constantTimeEqual(providedSignature, sha256);
  return matchesSha1 || matchesSha256;
}

/**
 * Length-safe wrapper around `timingSafeEqual`, which throws on differing
 * buffer lengths. A length mismatch just means the signatures can't be equal,
 * so `providedSignature` (attacker-controlled, any length) returns false
 * without leaking timing beyond the length itself.
 */
function constantTimeEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
