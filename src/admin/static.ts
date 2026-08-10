import { join } from "node:path";

/**
 * Where `bun run build:web` writes the bundled SPA. Resolved from this module's
 * own location rather than the process CWD, so it works the same whether the
 * server is started from the repo root or from `/app` in the container.
 */
export const WEB_DIST_DIR = join(import.meta.dir, "..", "..", "web", "dist");

export const BUNDLE_SCRIPT = "app.js";
export const BUNDLE_STYLESHEET = "app.css";

const MIME_BY_EXTENSION: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
};

/**
 * Only flat, well-formed filenames are servable — no separators, no dots-dots,
 * no unexpected extensions — so a crafted request can't walk out of the bundle
 * directory and read arbitrary files.
 */
export function resolveBundleFile(name: string): { path: string; mime: string } | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) return undefined;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) return undefined;
  return { path: join(WEB_DIST_DIR, name), mime };
}

export async function bundleExists(): Promise<boolean> {
  return Bun.file(join(WEB_DIST_DIR, BUNDLE_SCRIPT)).exists();
}

/**
 * The admin page's own CSP. Deliberately separate from (and much less
 * restrictive than) the delivery route's per-asset CSP — that one carries
 * `script-src 'none'` and `sandbox`, which would kill the SPA's bundle. Only
 * same-origin script/style/XHR is allowed, and previews come from this server's
 * own delivery route (plus any configured public base URL).
 */
export function adminCsp(extraImageOrigin?: string): string {
  const imgSrc = ["'self'", "data:", extraImageOrigin].filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${imgSrc}`,
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Static HTML shell the SPA mounts into. Kept server-side so the build only has to emit JS/CSS. */
export function shellHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>cloudinary-mock-dev admin</title>
    <link rel="stylesheet" href="/admin/static/${BUNDLE_STYLESHEET}" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/admin/static/${BUNDLE_SCRIPT}"></script>
  </body>
</html>
`;
}

/** Shown instead of the SPA when the bundle is missing, so the failure is self-explanatory. */
export function missingBundleHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>cloudinary-mock-dev admin</title>
  </head>
  <body>
    <h1>Admin UI bundle not built</h1>
    <p>Run <code>bun run build:web</code> to build the admin interface, then reload this page.</p>
  </body>
</html>
`;
}
