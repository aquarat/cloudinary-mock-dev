export interface Config {
  port: number;
  dataDir: string;
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Overrides the host used when building asset URLs; falls back to the incoming request's Host header. */
  publicBaseUrl: string | undefined;
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

export function loadConfig(): Config {
  return {
    port: Number(env("PORT", "3000")),
    dataDir: env("DATA_DIR", "./data"),
    cloudName: env("CLOUDINARY_CLOUD_NAME", DEFAULT_CLOUD_NAME),
    apiKey: env("CLOUDINARY_API_KEY", DEFAULT_API_KEY),
    apiSecret: env("CLOUDINARY_API_SECRET", DEFAULT_API_SECRET),
    publicBaseUrl: process.env["PUBLIC_BASE_URL"]?.replace(/\/+$/, "") || undefined,
  };
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
