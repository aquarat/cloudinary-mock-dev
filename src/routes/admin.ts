import { Hono, type Context } from "hono";
import { clearSessionCookie, credentialsMatch, issueToken, requireAdminToken, setSessionCookie } from "../admin/auth";
import { adminCsp, bundleExists, missingBundleHtml, resolveBundleFile, shellHtml } from "../admin/static";
import { clientIp } from "../clientIp";
import type { Config } from "../config";
import { mimeForFormat } from "../contentType";
import { buildDeliveryUrl } from "../deliveryUrl";
import { log } from "../logger";
import { getRequestId } from "../requestContext";
import type { AssetIdentity, AssetStore } from "../store";
import type { AssetRecord, DeliveryType, ResourceType } from "../types";

const RESOURCE_TYPES: ResourceType[] = ["image", "video", "raw"];
const DELIVERY_TYPES: DeliveryType[] = ["upload", "private", "authenticated", "fetch"];

/** Upper bound on assets removed per bulk request, in both explicit and filter mode. */
const BULK_DELETE_BATCH = 500;

// Formats the browser can safely paint into an <img>. Everything else is sent
// by the delivery route as `Content-Disposition: attachment` under a sandboxing
// CSP (SVG, PDF, raw) or isn't an image at all (video), so the UI shows a
// placeholder instead of a broken thumbnail.
const PREVIEWABLE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);

function isPreviewable(record: AssetRecord): boolean {
  return record.resourceType === "image" && PREVIEWABLE_MIME.has(mimeForFormat(record.format));
}

/** Origin of `publicBaseUrl`, so previews served from a configured external host aren't blocked by the admin CSP. */
function publicImageOrigin(config: Config): string | undefined {
  if (!config.publicBaseUrl) return undefined;
  try {
    return new URL(config.publicBaseUrl).origin;
  } catch {
    return undefined;
  }
}

const LOGIN_PATH = "/admin/api/login";

/**
 * Optional admin UI: a React SPA plus the JSON endpoints it talks to. Only
 * mounted by `createApp` when admin credentials are configured — see
 * `isAdminEnabled` in src/config.ts — so on a default deployment `/admin`
 * simply does not exist.
 */
export function createAdminRoute(config: Config, store: AssetStore, secret: string): Hono {
  const app = new Hono();
  const guard = requireAdminToken(secret);
  const imageOrigin = publicImageOrigin(config);

  // Applied to the whole API surface rather than per-handler, so a new endpoint
  // is authenticated by default. Login is the single explicit exemption.
  app.use("/admin/api/*", async (c, next) => {
    if (c.req.path === LOGIN_PATH) return next();
    return guard(c, next);
  });

  app.post(LOGIN_PATH, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "Expected a JSON body" } }, 400);
    }
    const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
    const ok =
      typeof username === "string" && typeof password === "string" && credentialsMatch(config, username, password);

    if (!ok) {
      log.warn("admin_login_failed", { req_id: getRequestId(c), ip: clientIp(c) });
      return c.json({ error: { message: "Invalid credentials" } }, 401);
    }

    log.info("admin_login", { req_id: getRequestId(c), ip: clientIp(c) });
    const token = await issueToken(username as string, secret);
    // Mirrored into a cookie purely so the rate limiter can recognise this
    // operator on the thumbnail requests the table issues — see the note on
    // ADMIN_SESSION_COOKIE. API calls still authenticate via the bearer token.
    setSessionCookie(c, token);
    return c.json({ token });
  });

  app.post("/admin/api/logout", (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get("/admin/api/assets", (c) => {
    const query = c.req.query();
    const limit = query["limit"] === undefined ? undefined : Number(query["limit"]);
    const offset = query["offset"] === undefined ? undefined : Number(query["offset"]);
    // The store validates sort/order against an allowlist and clamps the paging
    // window, so unparseable input degrades to the defaults rather than erroring.
    const result = store.list({
      sort: query["sort"],
      order: query["order"],
      filter: query["q"],
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    });

    return c.json({
      assets: result.items.map((record) => ({
        public_id: record.publicId,
        resource_type: record.resourceType,
        type: record.type,
        format: record.format,
        bytes: record.bytes,
        width: record.width,
        height: record.height,
        tags: record.tags,
        created_at: record.createdAt,
        version: record.version,
        url: buildDeliveryUrl(c, config, record),
        previewable: isPreviewable(record),
      })),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      sort: result.sort,
      order: result.order,
    });
  });

  // public_ids contain slashes ("folder/name"), which would be split across path
  // segments, so the identity travels in the body instead of the URL.
  app.post("/admin/api/assets/delete", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "Expected a JSON body" } }, 400);
    }
    const {
      resource_type: resourceType,
      type,
      public_id: publicId,
    } = (body ?? {}) as { resource_type?: unknown; type?: unknown; public_id?: unknown };

    if (typeof publicId !== "string" || publicId === "") {
      return c.json({ error: { message: "Missing public_id" } }, 400);
    }
    if (typeof resourceType !== "string" || !RESOURCE_TYPES.includes(resourceType as ResourceType)) {
      return c.json({ error: { message: "Invalid resource_type" } }, 400);
    }
    if (typeof type !== "string" || !DELIVERY_TYPES.includes(type as DeliveryType)) {
      return c.json({ error: { message: "Invalid type" } }, 400);
    }

    // Reuses the same destroy path as the signed Upload-API route, so the blob
    // on disk and the metadata row are removed together.
    const deleted = await store.destroy(resourceType as ResourceType, type as DeliveryType, publicId);
    log.info("admin_destroy", {
      req_id: getRequestId(c),
      ip: clientIp(c),
      public_id: publicId,
      resource_type: resourceType,
      deleted,
    });
    return c.json({ deleted });
  });

  /**
   * Bulk deletion, in two modes:
   *
   *   { assets: [{resource_type, type, public_id}, …] }  — an explicit set, i.e.
   *     the rows the operator ticked. Capped per request so one call can't be
   *     turned into an unbounded amount of work.
   *
   *   { all_matching: true, q?: string }  — everything matching the same filter
   *     the listing uses, which is how "select all N results" spanning pages is
   *     honoured without shipping every id to the client. Deletes one bounded
   *     batch and reports `remaining`, so the caller loops and can show progress.
   *
   * Filter mode with an absent/empty `q` means *every* asset, which is a
   * legitimate "empty the store" request but an expensive mistake if it was not
   * intended — hence the explicit `all_matching` flag rather than inferring the
   * mode from a missing list, and the operation is logged either way.
   */
  app.post("/admin/api/assets/bulk-delete", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "Expected a JSON body" } }, 400);
    }
    const {
      assets,
      all_matching: allMatching,
      q,
    } = (body ?? {}) as {
      assets?: unknown;
      all_matching?: unknown;
      q?: unknown;
    };

    if (allMatching === true) {
      const filter = typeof q === "string" && q.trim() !== "" ? q.trim() : undefined;
      const { deleted, remaining } = await store.destroyMatching(filter, BULK_DELETE_BATCH);
      log.warn("admin_bulk_destroy", {
        req_id: getRequestId(c),
        ip: clientIp(c),
        mode: "filter",
        filter: filter ?? "(all)",
        deleted,
        remaining,
      });
      return c.json({ deleted, remaining });
    }

    if (!Array.isArray(assets)) {
      return c.json({ error: { message: "Expected `assets` array or `all_matching: true`" } }, 400);
    }
    if (assets.length === 0) {
      return c.json({ error: { message: "No assets supplied" } }, 400);
    }
    if (assets.length > BULK_DELETE_BATCH) {
      return c.json({ error: { message: `At most ${BULK_DELETE_BATCH} assets per request` } }, 400);
    }

    const identities: AssetIdentity[] = [];
    for (const entry of assets) {
      const {
        resource_type: resourceType,
        type,
        public_id: publicId,
      } = (entry ?? {}) as { resource_type?: unknown; type?: unknown; public_id?: unknown };

      if (typeof publicId !== "string" || publicId === "") {
        return c.json({ error: { message: "Each asset needs a public_id" } }, 400);
      }
      if (typeof resourceType !== "string" || !RESOURCE_TYPES.includes(resourceType as ResourceType)) {
        return c.json({ error: { message: `Invalid resource_type for ${publicId}` } }, 400);
      }
      if (typeof type !== "string" || !DELIVERY_TYPES.includes(type as DeliveryType)) {
        return c.json({ error: { message: `Invalid type for ${publicId}` } }, 400);
      }
      identities.push({ resourceType: resourceType as ResourceType, type: type as DeliveryType, publicId });
    }

    const deleted = await store.destroyMany(identities);
    log.warn("admin_bulk_destroy", {
      req_id: getRequestId(c),
      ip: clientIp(c),
      mode: "explicit",
      requested: identities.length,
      deleted,
    });
    return c.json({ deleted, remaining: 0 });
  });

  app.get("/admin/static/:file", async (c) => {
    const resolved = resolveBundleFile(c.req.param("file"));
    if (!resolved) return c.notFound();
    const file = Bun.file(resolved.path);
    if (!(await file.exists())) return c.notFound();
    return new Response(file, {
      headers: {
        "Content-Type": resolved.mime,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      },
    });
  });

  const serveShell = async (c: Context) => {
    const html = (await bundleExists()) ? shellHtml() : missingBundleHtml();
    return c.html(html, 200, {
      "Content-Security-Policy": adminCsp(imageOrigin),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
    });
  };

  app.get("/admin", serveShell);
  app.get("/admin/", serveShell);

  return app;
}
