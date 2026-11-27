import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { hasValidAdminSession, resolveJwtSecret } from "./admin/auth";
import { isAdminEnabled, type Config } from "./config";
import { MAX_UPLOAD_BYTES } from "./fileInput";
import { log } from "./logger";
import { createRateLimit } from "./middleware/rateLimit";
import { requestId } from "./middleware/requestId";
import { requestLog } from "./middleware/requestLog";
import { createAdminRoute } from "./routes/admin";
import { createDeliveryRoute } from "./routes/delivery";
import { createDestroyRoute } from "./routes/destroy";
import { createHealthRoute } from "./routes/health";
import { createTagsRoute } from "./routes/tags";
import { createUploadRoute } from "./routes/upload";
import type { AssetStore } from "./store";

// Ceiling on an Upload API request body. It follows MAX_UPLOAD_BYTES rather
// than being a fixed number, so raising the upload cap is enough on its own: a
// file sent as a base64 data URI is a third larger than its bytes, and the
// extra MiB covers the other form fields.
const API_BODY_LIMIT_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024 * 1024;

export function createApp(config: Config, store: AssetStore): Hono {
  const app = new Hono();
  if (config.corsOrigins?.length) {
    app.use(
      "/v1_1/*",
      cors({
        origin: config.corsOrigins,
        allowMethods: ["POST", "OPTIONS"],
        // Cloudinary's browser SDKs and upload widget mark their XHRs with
        // X-Requested-With, which makes it part of the preflight.
        allowHeaders: ["Content-Type", "X-Requested-With"],
        maxAge: 600,
      }),
    );
  }
  app.use(
    "/v1_1/*",
    bodyLimit({
      maxSize: API_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: { message: `Request body exceeds ${API_BODY_LIMIT_BYTES} bytes.` } }, 413),
    }),
  );
  app.use(async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });
  const adminEnabled = isAdminEnabled(config);
  // Resolved once and shared: `resolveJwtSecret` mints a fresh random secret
  // when ADMIN_JWT_SECRET is unset, so calling it per consumer would issue
  // tokens signed with one secret and verify them against another.
  const adminSecret = adminEnabled ? resolveJwtSecret(config) : undefined;

  app.use(requestId);
  // A signed-in admin is exempt from rate limiting: one table page issues an API
  // call plus a thumbnail request per row, which would otherwise exhaust a limit
  // sized for anonymous callers after a couple of pages.
  app.use(createRateLimit(adminSecret ? { isExempt: hasValidAdminSession(adminSecret) } : {}));
  app.use(requestLog);

  app.route("/", createHealthRoute());
  // Upload-API style routes (mimics api.cloudinary.com/v1_1/...).
  app.route("/", createUploadRoute(config, store));
  app.route("/", createDestroyRoute(config, store));
  app.route("/", createTagsRoute(config, store));

  // Optional admin UI. Registered only when credentials are configured — with
  // none set there is no /admin route at all, so it 404s like any unknown path.
  // Must come before the delivery route: that route's catch-all pattern would
  // otherwise swallow /admin/... paths of four or more segments.
  if (adminEnabled && adminSecret) {
    log.info("admin_ui", { enabled: true, path: "/admin" });
    app.route("/", createAdminRoute(config, store, adminSecret));
  } else {
    log.info("admin_ui", { enabled: false, hint: "set ADMIN_USERNAME and ADMIN_PASSWORD to enable" });
  }

  // Delivery-CDN style routes (mimics res.cloudinary.com/<cloud_name>/...).
  // Registered LAST: `/:cloudName/:resourceType/:type/*` matches any path of
  // four or more segments, so anything after it would be unreachable.
  app.route("/", createDeliveryRoute(config.cloudName, store, { urls: config.deliveryFallbackUrls ?? [] }));

  return app;
}
