import { imageSize } from "image-size";
import type { ResourceType } from "./types";

export interface MediaInfo {
  format: string;
  width: number | null;
  height: number | null;
}

const EXT_FROM_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

function extFromFilename(name: string | null): string | null {
  if (!name) return null;
  const match = name.match(/\.([a-zA-Z0-9]+)$/);
  return match ? ((match[1] ?? null)?.toLowerCase() ?? null) : null;
}

export function inspectMedia(params: {
  resourceType: ResourceType;
  bytes: Uint8Array;
  originalFilename: string | null;
  contentType: string | null;
  requestedFormat?: string;
}): MediaInfo {
  const { resourceType, bytes, originalFilename, contentType, requestedFormat } = params;

  if (resourceType === "image") {
    try {
      const dimensions = imageSize(bytes);
      return {
        format: requestedFormat || dimensions.type || "jpg",
        width: dimensions.width,
        height: dimensions.height,
      };
    } catch {
      // Falls through for inputs image-size can't parse (e.g. an SVG-less non-image slipped in as "image").
    }
  }

  const format =
    requestedFormat ||
    extFromFilename(originalFilename) ||
    (contentType ? EXT_FROM_MIME[contentType.split(";")[0]!.trim()] : null) ||
    "bin";

  return { format, width: null, height: null };
}
