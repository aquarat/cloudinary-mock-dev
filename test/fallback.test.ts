import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { parseFallbackUrls, type Config } from "../src/config";
import { signParams } from "../src/signature";
import { AssetStore } from "../src/store";

const ONE_PIXEL_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("parseFallbackUrls", () => {
  test("is empty when unset or blank", () => {
    expect(parseFallbackUrls(undefined)).toEqual([]);
    expect(parseFallbackUrls("  ")).toEqual([]);
  });

  test("splits on commas and drops trailing slashes", () => {
    expect(parseFallbackUrls(" https://res.cloudinary.com/one/ ,https://res.cloudinary.com/two")).toEqual([
      "https://res.cloudinary.com/one",
      "https://res.cloudinary.com/two",
    ]);
  });

  test("refuses anything that is not an http(s) base URL", () => {
    expect(() => parseFallbackUrls("res.cloudinary.com/one")).toThrow(/not a URL/);
    expect(() => parseFallbackUrls("ftp://example.com/one")).toThrow(/not an http/);
    expect(() => parseFallbackUrls("https://example.com/one?x=1")).toThrow(/no query/);
  });
});

describe("delivery fallback", () => {
  let dataDir: string;
  // Two stand-in upstream clouds: "first" holds only first.png, "second" holds everything.
  let upstream: ReturnType<typeof Bun.serve>;
  const probes: string[] = [];
  let upstreamUrl: string;

  const config = (urls: string[]): Config => ({
    port: 0,
    dataDir,
    cloudName: "test-cloud",
    apiKey: "test-key",
    apiSecret: "test-secret",
    publicBaseUrl: undefined,
    deliveryFallbackUrls: urls,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-fallback-"));
    upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        probes.push(`${request.method} ${pathname}`);
        if (pathname.startsWith("/first/") && !pathname.endsWith("/first.png")) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 200 });
      },
    });
    upstreamUrl = `http://localhost:${upstream.port}`;
  });

  afterAll(async () => {
    upstream.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  });

  const appWith = async (urls: string[]) => createApp(config(urls), await AssetStore.open(dataDir));

  test("is off by default: a miss is a plain 404", async () => {
    const app = await appWith([]);
    const res = await app.request("/test-cloud/image/upload/v1/nothing-here.png");
    expect(res.status).toBe(404);
  });

  test("redirects a miss to the single fallback without probing it", async () => {
    const app = await appWith([`${upstreamUrl}/second`]);
    probes.length = 0;
    const res = await app.request("/test-cloud/image/upload/c_fill,w_600/v12/logos/a%20b.png?_a=x");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${upstreamUrl}/second/image/upload/c_fill,w_600/v12/logos/a%20b.png?_a=x`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(probes).toEqual([]);
  });

  test("probes the bases in order and redirects to the first that has the asset", async () => {
    const app = await appWith([`${upstreamUrl}/first`, `${upstreamUrl}/second`]);
    probes.length = 0;

    const inFirst = await app.request("/test-cloud/image/upload/first.png");
    expect(inFirst.headers.get("location")).toBe(`${upstreamUrl}/first/image/upload/first.png`);

    const notInFirst = await app.request("/test-cloud/image/upload/other.png");
    expect(notInFirst.headers.get("location")).toBe(`${upstreamUrl}/second/image/upload/other.png`);

    // The last base is never probed, and an answer is remembered.
    await app.request("/test-cloud/image/upload/other.png");
    expect(probes).toEqual(["HEAD /first/image/upload/first.png", "HEAD /first/image/upload/other.png"]);
  });

  test("falls through an unreachable base", async () => {
    const app = await appWith(["http://127.0.0.1:9", `${upstreamUrl}/second`]);
    const res = await app.request("/test-cloud/image/upload/unreachable.png");
    expect(res.headers.get("location")).toBe(`${upstreamUrl}/second/image/upload/unreachable.png`);
  });

  test("still serves what it holds, and never redirects another cloud's URL", async () => {
    const app = await appWith([`${upstreamUrl}/second`]);
    const timestamp = Math.floor(Date.now() / 1000);
    const form = new FormData();
    form.append("file", ONE_PIXEL_PNG_DATA_URI);
    form.append("api_key", "test-key");
    form.append("timestamp", String(timestamp));
    form.append("public_id", "held");
    form.append("signature", signParams({ public_id: "held", timestamp }, "test-secret"));
    expect((await app.request("/v1_1/test-cloud/image/upload", { method: "POST", body: form })).status).toBe(200);

    const held = await app.request("/test-cloud/image/upload/w_10/held.png");
    expect(held.status).toBe(200);
    expect(held.headers.get("content-type")).toBe("image/png");

    expect((await app.request("/other-cloud/image/upload/held.png")).status).toBe(404);
  });
});

describe("upload without a resource type in the path", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-alias-"));
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("is an image upload, as on Cloudinary", async () => {
    const app = createApp(
      {
        port: 0,
        dataDir,
        cloudName: "test-cloud",
        apiKey: "test-key",
        apiSecret: "test-secret",
        publicBaseUrl: "https://res.cloudinary.com",
      },
      await AssetStore.open(dataDir),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    // JSON, as browser uploaders built on fetch() commonly send it.
    const res = await app.request("/v1_1/test-cloud/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        file: ONE_PIXEL_PNG_DATA_URI,
        folder: "aliased",
        timestamp,
        api_key: "test-key",
        signature: signParams({ folder: "aliased", timestamp }, "test-secret"),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body["resource_type"]).toBe("image");
    expect(body["secure_url"]).toStartWith("https://res.cloudinary.com/test-cloud/image/upload/");

    const wrongCloud = await app.request("/v1_1/other-cloud/upload", { method: "POST", body: new FormData() });
    expect(wrongCloud.status).toBe(401);
  });
});
