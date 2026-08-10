const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Cloudinary generates a random ~20-char public_id when none is supplied. */
export function randomPublicId(length = 20): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/**
 * Cloudinary public_ids and folders legitimately use `/` as a folder separator,
 * but that same value later becomes part of an on-disk storage key. Without
 * cleaning, a value like `../../../../etc/whatever` would collapse out of the
 * intended blobs directory (arbitrary file write). We defend by treating the
 * value as a set of path segments and dropping anything that could traverse:
 * null bytes and backslashes are stripped, leading/trailing/duplicate slashes
 * collapse, and any `.`/`..`/empty segment is discarded. Internal `/` between
 * real segments is preserved so nested folders still work.
 */
export function sanitizePathValue(value: string): string {
  return value
    .replace(/\0/g, "") // strip null bytes (path terminators / smuggling)
    .replace(/\\/g, "/") // normalise backslashes so they can't hide traversal
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .join("/");
}

/** Mirrors Cloudinary: an explicit `folder` is prepended to the effective public_id. */
export function resolvePublicId(params: { publicId?: string; folder?: string }): string {
  const { publicId, folder } = params;
  // Sanitise both attacker-controlled inputs before they can influence the
  // storage key. A public_id that is empty after cleaning falls back to a
  // random id, exactly as if none had been supplied.
  const cleanPublicId = publicId ? sanitizePathValue(publicId) : "";
  const base = cleanPublicId || randomPublicId();
  const cleanFolder = folder ? sanitizePathValue(folder) : "";
  if (!cleanFolder) return base;
  const prefix = `${cleanFolder}/`;
  return base.startsWith(prefix) ? base : `${prefix}${base}`;
}
