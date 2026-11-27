export interface Config {
  port: number;
  dataDir: string;
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Overrides the host used when building asset URLs; falls back to the incoming request's Host header. */
  publicBaseUrl: string | undefined;
  /** When true, uploads must carry a valid signature with a current timestamp; unsigned `upload_preset` uploads are refused. */
  requireSignedUploads?: boolean;
  /** Exact origins allowed to call the Upload API from a browser. Empty or omitted means no CORS headers are sent. */
  corsOrigins?: string[];
  /**
   * Where a delivery request for an asset this server does not hold is
   * redirected, in order of preference (e.g. `https://res.cloudinary.com/my-real-cloud`).
   * Empty (the default) keeps the plain 404. See `parseFallbackUrls`.
   */
  deliveryFallbackUrls?: string[] | undefined;
  // The admin fields are optional so a Config literal without them (the common
  // case, and what most tests build) is still valid — omitted means disabled.
  /** Admin UI username. The admin UI only exists when this AND `adminPassword` are set. */
  adminUsername?: string | undefined;
  /** Admin UI password. The admin UI only exists when this AND `adminUsername` are set. */
  adminPassword?: string | undefined;
  /** HMAC secret for admin session tokens. When unset a random one is generated per boot (sessions die on restart). */
  adminJwtSecret?: string | undefined;
}

/**
 * Built-in fallbacks for the Cloudinary credentials. These are committed to the
 * repo, so anyone can forge valid signatures with them — they are only ever safe
 * on a throwaway local instance. `validateConfig` refuses to let them through
 * unless dev mode is explicitly permitted.
 */
export const DEFAULT_CLOUD_NAME = "some-name-test";
export const DEFAULT_API_KEY = "123456789";
export const DEFAULT_API_SECRET = "abcdef1234567890";

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

/** Like `env`, but with no fallback: blank/whitespace-only values read as "not set". */
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

export function loadConfig(): Config {
  return {
    port: Number(env("PORT", "3000")),
    dataDir: env("DATA_DIR", "./data"),
    cloudName: env("CLOUDINARY_CLOUD_NAME", DEFAULT_CLOUD_NAME),
    apiKey: env("CLOUDINARY_API_KEY", DEFAULT_API_KEY),
    apiSecret: env("CLOUDINARY_API_SECRET", DEFAULT_API_SECRET),
    publicBaseUrl: process.env["PUBLIC_BASE_URL"]?.replace(/\/+$/, "") || undefined,
    requireSignedUploads: process.env["REQUIRE_SIGNED_UPLOADS"] === "1",
    corsOrigins: (process.env["CORS_ORIGINS"] || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    deliveryFallbackUrls: parseFallbackUrls(process.env["DELIVERY_FALLBACK_URLS"]),
    adminUsername: optionalEnv("ADMIN_USERNAME"),
    adminPassword: optionalEnv("ADMIN_PASSWORD"),
    adminJwtSecret: optionalEnv("ADMIN_JWT_SECRET"),
  };
}

/**
 * `DELIVERY_FALLBACK_URLS` is a comma-separated list of delivery bases, each the
 * part of a delivery URL before `/<resource_type>/<type>/...`, for instance
 * `https://res.cloudinary.com/my-real-cloud`. Anything that is not an absolute
 * http(s) URL is a configuration mistake, so it throws rather than being dropped
 * silently.
 */
export function parseFallbackUrls(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter((entry) => entry !== "")
    .map((entry) => {
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new Error(`DELIVERY_FALLBACK_URLS: not a URL: ${entry}`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`DELIVERY_FALLBACK_URLS: not an http(s) URL: ${entry}`);
      }
      if (url.search || url.hash) {
        throw new Error(`DELIVERY_FALLBACK_URLS: a base URL takes no query or fragment: ${entry}`);
      }
      return entry;
    });
}

/**
 * The admin UI is opt-in: it is only mounted when a username *and* a password
 * are configured. Anything less and no `/admin` route is registered at all, so
 * the panel cannot be reached (or brute-forced) on a default deployment.
 */
export function isAdminEnabled(config: Config): boolean {
  return (
    typeof config.adminUsername === "string" &&
    config.adminUsername.trim() !== "" &&
    typeof config.adminPassword === "string" &&
    config.adminPassword.trim() !== ""
  );
}

/** Which of the credentials are still sitting on their committed default value. */
export function usingDefaultCredentials(config: Config): string[] {
  const offenders: string[] = [];
  if (config.cloudName === DEFAULT_CLOUD_NAME) offenders.push("CLOUDINARY_CLOUD_NAME");
  if (config.apiKey === DEFAULT_API_KEY) offenders.push("CLOUDINARY_API_KEY");
  if (config.apiSecret === DEFAULT_API_SECRET) offenders.push("CLOUDINARY_API_SECRET");
  return offenders;
}

/**
 * Default credentials are convenient for local dev but a hole in production, so
 * they are only allowed when dev mode is opted into explicitly: `NODE_ENV` other
 * than "production" (the usual local default), or a truthy `ALLOW_DEFAULT_CREDENTIALS`.
 */
export function isDevModeAllowed(): boolean {
  const allowFlag = process.env["ALLOW_DEFAULT_CREDENTIALS"];
  if (allowFlag && allowFlag.trim() !== "" && allowFlag !== "0" && allowFlag !== "false") {
    return true;
  }
  return process.env["NODE_ENV"] !== "production";
}

export interface ConfigValidation {
  /** Credential env vars still on their built-in default, e.g. CLOUDINARY_API_SECRET. */
  defaults: string[];
  /** True when defaults are present but dev mode makes them tolerable (warn, don't abort). */
  devModeAllowed: boolean;
  /** True when defaults are present and dev mode is not permitted — startup must abort. */
  fatal: boolean;
}

/**
 * Inspects a config for insecure default credentials. Pure and side-effect free
 * (no logging, no process.exit) so it stays testable and importing config.ts can
 * never kill a process — the caller decides how to react to `fatal`.
 */
export function validateConfig(config: Config): ConfigValidation {
  const defaults = usingDefaultCredentials(config);
  const devModeAllowed = isDevModeAllowed();
  return {
    defaults,
    devModeAllowed,
    fatal: defaults.length > 0 && !devModeAllowed,
  };
}
