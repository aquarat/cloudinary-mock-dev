import type { Context } from "hono";

export type ParsedParams = Record<string, unknown>;

export async function parseParams(c: Context): Promise<ParsedParams> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await c.req.json()) as ParsedParams;
  }

  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    return (await c.req.parseBody({ all: true })) as ParsedParams;
  }

  // Some Cloudinary SDK builds omit a content-type on plain form posts.
  try {
    return (await c.req.parseBody({ all: true })) as ParsedParams;
  } catch {
    return {};
  }
}

export function stringParam(params: ParsedParams, key: string): string | undefined {
  const value = params[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/** Handles both `public_ids` (array from repeated fields) and the bracketed `public_ids[]` form some clients send. */
export function arrayParam(params: ParsedParams, key: string): string[] {
  const direct = params[key] ?? params[`${key}[]`];
  if (direct === undefined) return [];
  if (Array.isArray(direct)) return direct.map(String);
  return [String(direct)];
}

export function tagsParam(params: ParsedParams): string[] {
  const value = params["tags"];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}
