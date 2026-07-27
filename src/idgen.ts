const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Cloudinary generates a random ~20-char public_id when none is supplied. */
export function randomPublicId(length = 20): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** Mirrors Cloudinary: an explicit `folder` is prepended to the effective public_id. */
export function resolvePublicId(params: { publicId?: string; folder?: string }): string {
  const { publicId, folder } = params;
  const base = publicId || randomPublicId();
  if (!folder) return base;
  const prefix = `${folder.replace(/\/+$/, "")}/`;
  return base.startsWith(prefix) ? base : `${prefix}${base}`;
}
