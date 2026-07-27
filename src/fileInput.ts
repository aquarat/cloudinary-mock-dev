export interface ResolvedFile {
  bytes: Uint8Array;
  originalFilename: string | null;
  contentType: string | null;
}

const DATA_URI_RE = /^data:([^;,]+)?(;base64)?,(.*)$/s;

export async function resolveFileInput(file: unknown): Promise<ResolvedFile> {
  if (file instanceof File) {
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      originalFilename: file.name || null,
      contentType: file.type || null,
    };
  }

  if (typeof file === "string") {
    if (/^https?:\/\//i.test(file)) {
      const response = await fetch(file);
      if (!response.ok) {
        throw new Error(`Failed to fetch remote file ${file}: ${response.status} ${response.statusText}`);
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        originalFilename: file.split("/").pop() || null,
        contentType: response.headers.get("content-type"),
      };
    }

    const dataUriMatch = file.match(DATA_URI_RE);
    if (dataUriMatch) {
      const [, mime, isBase64, payload] = dataUriMatch;
      const bytes = isBase64
        ? Uint8Array.from(atob(payload ?? ""), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(payload ?? ""));
      return { bytes, originalFilename: null, contentType: mime || null };
    }

    throw new Error("Unsupported `file` value: expected a remote URL, a data URI, or an uploaded file.");
  }

  throw new Error("Missing `file` param.");
}
