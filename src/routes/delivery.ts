import { Hono } from "hono";
import { mimeForFormat } from "../contentType";
import { parseDeliveryPath } from "../deliveryUrl";
import { log } from "../logger";
import { getRequestId } from "../requestContext";
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
const DELIVERY_CSP = "default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

// Strips path separators, quotes and control characters so the value is safe to
// embed in a Content-Disposition header. Falls back to a generic name.
function sanitiseFilename(publicId: string, format: string | null): string {
  const base = publicId.split("/").pop() ?? publicId;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "asset";
  return format ? `${cleaned}.${format.toLowerCase()}` : cleaned;
}

export interface DeliveryFallbackOptions {
  /** Delivery bases to redirect a miss to, in order of preference (see `parseFallbackUrls`). */
  urls: string[];
  /** How long the outcome of probing for one asset is remembered. */
  probeTtlMs?: number;
  /** How long to wait for one probe before trying the next base. */
  probeTimeoutMs?: number;
}

const PROBE_CACHE_LIMIT = 10_000;

/**
 * Picks where a delivery miss is redirected. With a single base that is simply
 * the base, so no request leaves this server. With several, every base but the
 * last is probed with a HEAD of the same path, in order, and the first one that
 * answers 2xx wins; the last base is the answer when none does, so the browser
 * still gets the upstream's own 404. Outcomes are cached per path.
 */
function createFallbackResolver({ urls, probeTtlMs = 10 * 60_000, probeTimeoutMs = 5_000 }: DeliveryFallbackOptions) {
  const remembered = new Map<string, { base: string; expires: number }>();
  const last = urls[urls.length - 1];

  return async (suffix: string): Promise<string | undefined> => {
    if (last === undefined) return undefined;
    if (urls.length === 1) return last;

    const now = Date.now();
    const hit = remembered.get(suffix);
    if (hit && hit.expires > now) return hit.base;

    let chosen = last;
    for (const base of urls.slice(0, -1)) {
      try {
        const probe = await fetch(`${base}${suffix}`, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        if (probe.ok) {
          chosen = base;
          break;
        }
      } catch {
        // Unreachable or slow: try the next base.
      }
    }
    if (remembered.size >= PROBE_CACHE_LIMIT) {
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) remembered.delete(oldest);
    }
    remembered.set(suffix, { base: chosen, expires: now + probeTtlMs });
    return chosen;
  };
}

/**
 * Mimics `res.cloudinary.com/<cloud_name>/<resource_type>/<type>/[transformations/][vN/]<public_id>.<format>`.
 *
 * With `fallback.urls` set, a request for this cloud that names an asset the
 * store does not hold is answered with a 302 to the same path (transformations,
 * version and query string included) under a fallback base, typically a real
 * public cloud. That keeps a development database's existing images displaying
 * when the app has been pointed at this server. It is off by default.
 */
export function createDeliveryRoute(
  cloudName: string,
  store: AssetStore,
  fallback: DeliveryFallbackOptions = { urls: [] },
): Hono {
  const app = new Hono();
  const resolveFallback = createFallbackResolver(fallback);

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

    const miss = async () => {
      const url = new URL(c.req.url);
      // The path after /<cloud_name>, still percent-encoded as requested.
      const suffix = url.pathname.slice(cloudName.length + 1);
      const base = await resolveFallback(suffix);
      if (!base) return c.notFound();
      log.info("delivery_fallback", { req_id: getRequestId(c), public_id: publicId, to: base });
      return new Response(null, {
        status: 302,
        headers: { Location: `${base}${suffix}${url.search}`, "Cache-Control": "no-store" },
      });
    };

    const record =
      store.find(resourceType as ResourceType, type as DeliveryType, publicId) ??
      store.findByPublicIdAnyType(resourceType as ResourceType, publicId);
    if (!record) return miss();

    const bytes = await store.readBlob(record.storageKey);
    if (!bytes) return miss();

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
