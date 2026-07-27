export interface Config {
  port: number;
  dataDir: string;
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Overrides the host used when building asset URLs; falls back to the incoming request's Host header. */
  publicBaseUrl: string | undefined;
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export function loadConfig(): Config {
  return {
    port: Number(env("PORT", "3000")),
    dataDir: env("DATA_DIR", "./data"),
    cloudName: env("CLOUDINARY_CLOUD_NAME", "some-name-test"),
    apiKey: env("CLOUDINARY_API_KEY", "123456789"),
    apiSecret: env("CLOUDINARY_API_SECRET", "abcdef1234567890"),
    publicBaseUrl: process.env["PUBLIC_BASE_URL"]?.replace(/\/+$/, "") || undefined,
  };
}
