import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { signParams } from "../src/signature";
import { AssetStore } from "../src/store";

// A well-known 1x1 transparent PNG, used as a minimal but real image payload.
const ONE_PIXEL_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const TINY_SVG_DATA_URI = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "correct horse battery staple";

function baseConfig(dataDir: string): Config {
  return {
    port: 0,
    dataDir,
    cloudName: "test-cloud",
    apiKey: "test-key",
    apiSecret: "test-secret",
    publicBaseUrl: undefined,
  };
}

describe("admin UI gating", () => {
  let dataDir: string;
  let app: Hono;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-admin-off-test-"));
    // No ADMIN_USERNAME / ADMIN_PASSWORD: the router must not be registered.
    const store = await AssetStore.open(dataDir);
    app = createApp(baseConfig(dataDir), store);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("no /admin routes exist when credentials are not configured", async () => {
    expect((await app.request("/admin")).status).toBe(404);
    expect((await app.request("/admin/static/app.js")).status).toBe(404);
    expect((await app.request("/admin/api/assets")).status).toBe(404);

    const loginRes = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    expect(loginRes.status).toBe(404);
  });

  test("a half-configured admin (password only) stays disabled", async () => {
    const partialDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-admin-partial-test-"));
    try {
      const store = await AssetStore.open(partialDir);
      const partialApp = createApp({ ...baseConfig(partialDir), adminPassword: ADMIN_PASSWORD }, store);
      expect((await partialApp.request("/admin")).status).toBe(404);
    } finally {
      await rm(partialDir, { recursive: true, force: true });
    }
  });
});

describe("admin UI (enabled)", () => {
  let dataDir: string;
  let config: Config;
  let app: Hono;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-admin-test-"));
    config = {
      ...baseConfig(dataDir),
      adminUsername: ADMIN_USERNAME,
      adminPassword: ADMIN_PASSWORD,
      adminJwtSecret: "test-admin-jwt-secret",
    };
    const store = await AssetStore.open(dataDir);
    app = createApp(config, store);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Uploads through the real signed Upload API, so the admin sees genuine records. */
  const upload = async (dataUri: string, publicId: string, tags?: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const params: Record<string, string | number> = { public_id: publicId, timestamp };
    if (tags) params["tags"] = tags;
    const form = new FormData();
    form.append("file", dataUri);
    form.append("api_key", config.apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signParams(params, config.apiSecret));
    form.append("public_id", publicId);
    if (tags) form.append("tags", tags);
    const res = await app.request("/v1_1/test-cloud/image/upload", { method: "POST", body: form });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  const login = (username: string, password: string) =>
    app.request("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

  const token = async () => {
    const res = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
    return ((await res.json()) as { token: string }).token;
  };

  test("login rejects a wrong password and a wrong username", async () => {
    expect((await login(ADMIN_USERNAME, "wrong")).status).toBe(401);
    expect((await login("nobody", ADMIN_PASSWORD)).status).toBe(401);
  });

  test("login with the configured credentials returns a JWT", async () => {
    const res = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string };
    expect(typeof body.token).toBe("string");
    // Three dot-separated base64url segments — a real JWT, not a placeholder.
    expect(body.token!.split(".")).toHaveLength(3);
  });

  test("the assets endpoint is 401 without a token and 200 with one", async () => {
    expect((await app.request("/admin/api/assets")).status).toBe(401);
    expect((await app.request("/admin/api/assets", { headers: { Authorization: "Bearer not-a-token" } })).status).toBe(
      401,
    );

    const res = await app.request("/admin/api/assets", {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
  });

  test("deletion is also gated by the token", async () => {
    const res = await app.request("/admin/api/assets/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "image", type: "upload", public_id: "whatever" }),
    });
    expect(res.status).toBe(401);
  });

  test("listing returns uploaded assets and respects the sort parameter", async () => {
    await upload(ONE_PIXEL_PNG_DATA_URI, "zzz-last", "alpha,beta");
    await upload(TINY_SVG_DATA_URI, "aaa-first");

    const bearer = { Authorization: `Bearer ${await token()}` };
    const list = async (query: string) => {
      const res = await app.request(`/admin/api/assets?${query}`, { headers: bearer });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        assets: {
          public_id: string;
          bytes: number;
          tags: string[];
          url: string;
          previewable: boolean;
          format: string;
        }[];
        total: number;
      };
    };

    const ascending = await list("sort=name&order=asc");
    expect(ascending.total).toBe(2);
    expect(ascending.assets.map((asset) => asset.public_id)).toEqual(["aaa-first", "zzz-last"]);

    const descending = await list("sort=name&order=desc");
    expect(descending.assets.map((asset) => asset.public_id)).toEqual(["zzz-last", "aaa-first"]);

    // The PNG is the larger of the two, so it leads a descending size sort.
    const bySize = await list("sort=size&order=desc");
    expect(bySize.assets[0]!.public_id).toBe("zzz-last");

    const png = ascending.assets.find((asset) => asset.public_id === "zzz-last")!;
    expect(png.tags).toEqual(["alpha", "beta"]);
    expect(png.previewable).toBe(true);
    expect(png.url).toContain("/test-cloud/image/upload/");
    // SVG is served as an attachment by the delivery route, so it is not previewable inline.
    expect(ascending.assets.find((asset) => asset.public_id === "aaa-first")!.previewable).toBe(false);

    // A text filter narrows the result set.
    const filtered = await list("q=aaa");
    expect(filtered.total).toBe(1);
    expect(filtered.assets[0]!.public_id).toBe("aaa-first");
  });

  test("deleting an asset removes it so delivery 404s afterwards", async () => {
    const uploaded = await upload(ONE_PIXEL_PNG_DATA_URI, "doomed/asset");
    const deliveryPath = new URL(uploaded["url"] as string).pathname;
    expect((await app.request(deliveryPath)).status).toBe(200);

    const bearer = { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" };
    const res = await app.request("/admin/api/assets/delete", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ resource_type: "image", type: "upload", public_id: "doomed/asset" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    expect((await app.request(deliveryPath)).status).toBe(404);

    const listRes = await app.request("/admin/api/assets", {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    const listed = (await listRes.json()) as { assets: { public_id: string }[] };
    expect(listed.assets.map((asset) => asset.public_id)).not.toContain("doomed/asset");
  });

  test("GET /admin serves the SPA shell with a CSP that permits its own bundle", async () => {
    const res = await app.request("/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'none'");
    expect(await res.text()).toContain("<html");
  });
});

describe("admin bulk deletion", () => {
  let dataDir: string;
  let config: Config;
  let app: Hono;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-bulk-test-"));
    config = {
      ...baseConfig(dataDir),
      adminUsername: ADMIN_USERNAME,
      adminPassword: ADMIN_PASSWORD,
      adminJwtSecret: "test-admin-jwt-secret",
    };
    const store = await AssetStore.open(dataDir);
    app = createApp(config, store);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const upload = async (publicId: string, tags?: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const params: Record<string, string | number> = { public_id: publicId, timestamp };
    if (tags) params["tags"] = tags;
    const form = new FormData();
    form.append("file", ONE_PIXEL_PNG_DATA_URI);
    form.append("api_key", config.apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signParams(params, config.apiSecret));
    form.append("public_id", publicId);
    if (tags) form.append("tags", tags);
    const res = await app.request("/v1_1/test-cloud/image/upload", { method: "POST", body: form });
    expect(res.status).toBe(200);
  };

  const token = async () => {
    const res = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    return ((await res.json()) as { token: string }).token;
  };

  const bulkDelete = async (auth: string | null, body: unknown) =>
    app.request("/admin/api/assets/bulk-delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const count = async (auth: string, q?: string) => {
    const res = await app.request(`/admin/api/assets${q ? `?q=${encodeURIComponent(q)}` : ""}`, {
      headers: { Authorization: `Bearer ${auth}` },
    });
    return ((await res.json()) as { total: number }).total;
  };

  test("bulk delete requires a token", async () => {
    const res = await bulkDelete(null, { assets: [] });
    expect(res.status).toBe(401);
  });

  test("deletes an explicit list of assets and leaves the rest", async () => {
    const auth = await token();
    await upload("bulk/one");
    await upload("bulk/two");
    await upload("bulk/keep");

    const res = await bulkDelete(auth, {
      assets: [
        { resource_type: "image", type: "upload", public_id: "bulk/one" },
        { resource_type: "image", type: "upload", public_id: "bulk/two" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2, remaining: 0 });
    expect(await count(auth, "bulk/")).toBe(1);
  });

  test("rejects a malformed entry without deleting any of the batch", async () => {
    const auth = await token();
    await upload("guard/survivor");

    const res = await bulkDelete(auth, {
      assets: [
        { resource_type: "image", type: "upload", public_id: "guard/survivor" },
        { resource_type: "not-a-type", type: "upload", public_id: "guard/other" },
      ],
    });
    expect(res.status).toBe(400);
    // Validation happens up front, so the valid sibling in the batch survives.
    expect(await count(auth, "guard/survivor")).toBe(1);
  });

  test("filter mode deletes only what matches and reports the remainder", async () => {
    const auth = await token();
    await upload("apple/one");
    await upload("apple/two");
    await upload("banana/one");

    const res = await bulkDelete(auth, { all_matching: true, q: "apple" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; remaining: number };
    expect(body.deleted).toBe(2);
    expect(body.remaining).toBe(0);

    expect(await count(auth, "apple")).toBe(0);
    expect(await count(auth, "banana")).toBe(1);
  });

  test("filter mode matches tags, not just names", async () => {
    const auth = await token();
    await upload("tagged/alpha", "sunset");
    await upload("tagged/beta", "sunrise");

    const res = await bulkDelete(auth, { all_matching: true, q: "sunset" });
    expect(((await res.json()) as { deleted: number }).deleted).toBe(1);
    expect(await count(auth, "tagged/beta")).toBe(1);
  });

  test("an explicit list and all_matching are not confusable", async () => {
    const auth = await token();
    // Neither an assets array nor all_matching: refuse rather than guess.
    const res = await bulkDelete(auth, { q: "anything" });
    expect(res.status).toBe(400);
  });
});

describe("admin session cookie and rate-limit exemption", () => {
  let dataDir: string;
  let app: Hono;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-cookie-test-"));
    const config: Config = {
      ...baseConfig(dataDir),
      adminUsername: ADMIN_USERNAME,
      adminPassword: ADMIN_PASSWORD,
      adminJwtSecret: "test-admin-jwt-secret",
    };
    const store = await AssetStore.open(dataDir);
    app = createApp(config, store);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("login sets an httpOnly session cookie", async () => {
    const res = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("admin_session=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie).toContain("SameSite=Strict");
  });

  // The cookie exists only so the rate limiter can recognise an operator on
  // <img> requests. It must never stand in for the bearer token, or the admin
  // API would become CSRF-able from any page the operator visits.
  test("the session cookie does not authenticate the admin API", async () => {
    const login = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    const raw = login.headers.get("set-cookie") ?? "";
    const value = /admin_session=([^;]+)/.exec(raw)?.[1] ?? "";
    expect(value).not.toBe("");

    const res = await app.request("/admin/api/assets", { headers: { Cookie: `admin_session=${value}` } });
    expect(res.status).toBe(401);
  });

  test("logout clears the cookie", async () => {
    const login = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    const token = ((await login.json()) as { token: string }).token;
    const res = await app.request("/admin/api/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("admin_session=");
  });
});

describe("admin listing page size", () => {
  let dataDir: string;
  let app: Hono;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-pagesize-test-"));
    const config: Config = {
      ...baseConfig(dataDir),
      adminUsername: ADMIN_USERNAME,
      adminPassword: ADMIN_PASSWORD,
      adminJwtSecret: "test-admin-jwt-secret",
    };
    const store = await AssetStore.open(dataDir);
    app = createApp(config, store);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const listWith = async (query: string) => {
    const login = await app.request("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    const token = ((await login.json()) as { token: string }).token;
    const res = await app.request(`/admin/api/assets?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    return (await res.json()) as { limit: number };
  };

  // Every size the UI offers must survive the server's clamp — otherwise picking
  // 1000 would silently return 500 rows and paging would skip records.
  test.each([50, 100, 250, 500, 1000, 2500, 5000])("honours a page size of %i", async (size) => {
    expect((await listWith(`limit=${size}`)).limit).toBe(size);
  });

  test("clamps beyond the ceiling instead of accepting an unbounded page", async () => {
    expect((await listWith("limit=99999")).limit).toBe(5000);
  });

  test("falls back to the default for a nonsense limit", async () => {
    expect((await listWith("limit=abc")).limit).toBe(100);
  });
});
