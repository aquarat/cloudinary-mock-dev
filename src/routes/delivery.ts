import { Hono } from "hono";
import { mimeForFormat } from "../contentType";
import { parseDeliveryPath } from "../deliveryUrl";
import type { AssetStore } from "../store";
import type { DeliveryType, ResourceType } from "../types";

const RESOURCE_TYPES: ResourceType[] = ["image", "video", "raw"];
const DELIVERY_TYPES: DeliveryType[] = ["upload", "private", "authenticated", "fetch"];

// MIME types that are safe to render inline. These are inert raster image and
// video formats — the browser paints pixels but never executes markup. Anything
// outside this set (svg, pdf, application/octet-stream, ...) is served as an
// attachment so active content cannot run in this server's origin.
const INLINE_SAFE_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

// Restrictive CSP applied to every delivered asset. `sandbox` with no allow-
// tokens plus `script-src 'none'` stops SVG (or any HTML) from running scripts,
// while `img-src` still lets a genuine image render. `style-src 'unsafe-inline'`
// keeps inline presentation working for image documents.
const DELIVERY_CSP =
  "default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

// Strips path separators, quotes and control characters so the value is safe to
// embed in a Content-Disposition header. Falls back to a generic name.
function sanitiseFilename(publicId: string, format: string | null): string {
  const base = publicId.split("/").pop() ?? publicId;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "asset";
  return format ? `${cleaned}.${format.toLowerCase()}` : cleaned;
}

/** Mimics `res.cloudinary.com/<cloud_name>/<resource_type>/<type>/[transformations/][vN/]<public_id>.<format>`. */
export function createDeliveryRoute(cloudName: string, store: AssetStore): Hono {
  const app = new Hono();

  app.get("/:cloudName/:resourceType/:type/*", async (c) => {
    const { cloudName: requestedCloudName, resourceType, type } = c.req.param();
    if (
      requestedCloudName !== cloudName ||
      !RESOURCE_TYPES.includes(resourceType as ResourceType) ||
      !DELIVERY_TYPES.includes(type as DeliveryType)
    ) {
      return c.notFound();
    }

    const fullPath = c.req.path.split("/").filter(Boolean);
    // fullPath = [cloudName, resourceType, type, ...rest]
    const rest = fullPath.slice(3);
    const { publicId } = parseDeliveryPath(rest);
    if (!publicId) return c.notFound();

    const record =
      store.find(resourceType as ResourceType, type as DeliveryType, publicId) ??
      store.findByPublicIdAnyType(resourceType as ResourceType, publicId);
    if (!record) return c.notFound();

    const bytes = await store.readBlob(record.storageKey);
    if (!bytes) return c.notFound();

    const mime = mimeForFormat(record.format);
    // Inline only inert raster image/video types; force a download for
    // everything else (svg, pdf, octet-stream, ...) so active content can't be
    // rendered — and thus can't execute — in this server's origin.
    const disposition = INLINE_SAFE_MIME.has(mime) ? "inline" : "attachment";
    const filename = sanitiseFilename(publicId, record.format);

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.byteLength),
        // Defense in depth against stored XSS via uploaded active content:
        // stop MIME sniffing, sandbox/deny scripts, and download risky types.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": DELIVERY_CSP,
        "Content-Disposition": `${disposition}; filename="${filename}"`,
        // Transformations in the request path are accepted but ignored — this
        // always serves the originally-uploaded bytes. See README limitations.
        "Cache-Control": "no-store",
      },
    });
  });

  return app;
}
