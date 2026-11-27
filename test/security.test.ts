import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { isBlockedAddress, resolveFileInput } from "../src/fileInput";
import { resolvePublicId, sanitizePathValue } from "../src/idgen";
import { signParams } from "../src/signature";
import { AssetStore } from "../src/store";

// A well-known 1x1 transparent PNG, used as a minimal but real image payload.
const ONE_PIXEL_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const TINY_SVG_DATA_URI = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";

describe("path-traversal sanitisation", () => {
  test("sanitizePathValue drops traversal, empty and dot segments", () => {
    expect(sanitizePathValue("../../../../etc/pwned")).toBe("etc/pwned");
    expect(sanitizePathValue("a/./b/../c")).toBe("a/b/c");
    expect(sanitizePathValue("..\\..\\windows\\system32")).toBe("windows/system32");
    expect(sanitizePathValue("/leading/and/trailing/")).toBe("leading/and/trailing");
    expect(sanitizePathValue("with\0null")).toBe("withnull");
  });

  test("sanitizePathValue preserves legitimate nested folders", () => {
    expect(sanitizePathValue("gallery/2024/photo")).toBe("gallery/2024/photo");
  });

  test("resolvePublicId cannot escape via public_id", () => {
    expect(resolvePublicId({ publicId: "../../../../etc/pwned" })).toBe("etc/pwned");
  });

  test("resolvePublicId cannot escape via folder", () => {
    expect(resolvePublicId({ publicId: "photo", folder: "../../secret" })).toBe("secret/photo");
  });

  test("resolvePublicId falls back to a random id when nothing survives cleaning", () => {
    const id = resolvePublicId({ publicId: "../../.." });
    expect(id).not.toContain("..");
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("SSRF blocklist", () => {
  test("blocks the cloud-metadata endpoint and private/loopback ranges", () => {
    for (const ip of [
      "169.254.169.254", // link-local cloud metadata
      "127.0.0.1", // loopback
      "0.0.0.0", // unspecified
      "10.1.2.3", // private
      "172.16.0.1", // private (low boundary)
      "172.31.255.255", // private (high boundary)
      "192.168.1.1", // private
      "::1", // v6 loopback
      "::ffff:169.254.169.254", // v4-mapped metadata
      "fe80::1", // v6 link-local
      "fc00::1", // v6 unique-local
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  test("allows genuine public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  test("rejects a non-numeric host that was not resolved (fail closed)", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
  });

  test("resolveFileInput refuses to fetch a blocked address", async () => {
    // No allowlist entry for this host, so the guard must reject it before any fetch.
    await expect(resolveFileInput("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/SSRF|blocked/i);
  });
});

describe("upload route hardening (integration)", () => {
  let dataDir: string;
  let config: Config;
  let app: Hono;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-security-test-"));
    config = {
      port: 0,
      dataDir,
      cloudName: "test-cloud",
      apiKey: "test-key",
      apiSecret: "test-secret",
      publicBaseUrl: undefined,
    };
    const store = await AssetStore.open(dataDir);
    app = createApp(config, store);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    // Only exists if the `type` traversal test below found a regression.
    await rm(`${dataDir}-escaped`, { recursive: true, force: true });
  });

  test("a traversal public_id is sanitised, not written outside the blobs dir", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = "../../../../etc/pwned";
    const signature = signParams({ public_id: publicId, timestamp }, config.apiSecret);

    const form = new FormData();
    form.append("file", ONE_PIXEL_PNG_DATA_URI);
    form.append("api_key", config.apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);
    form.append("public_id", publicId);

    const res = await app.request("/v1_1/test-cloud/image/upload", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The effective id has the traversal segments stripped, so the on-disk key
    // stays inside DATA_DIR/blobs.
    expect(body["public_id"]).toBe("etc/pwned");
    expect(String(body["url"])).not.toContain("..");

    // And the sanitised asset is still retrievable through delivery.
    const deliveryPath = new URL(body["url"] as string).pathname;
    const deliveryRes = await app.request(deliveryPath);
    expect(deliveryRes.status).toBe(200);
  });

  test("a traversal `type` is rejected, on signed and unsigned uploads alike", async () => {
    // `image/<type>` under DATA_DIR/blobs: three levels up is DATA_DIR's parent.
    // The target is named after this run's own temp dir so it can't collide.
    const escapeDir = `${dataDir}-escaped`;
    const type = `../../../${basename(escapeDir)}`;
    const timestamp = Math.floor(Date.now() / 1000);

    const signed = new FormData();
    signed.append("file", ONE_PIXEL_PNG_DATA_URI);
    signed.append("api_key", config.apiKey);
    signed.append("timestamp", String(timestamp));
    signed.append("signature", signParams({ public_id: "pwned", timestamp, type }, config.apiSecret));
    signed.append("public_id", "pwned");
    signed.append("type", type);

    const unsigned = new FormData();
    unsigned.append("file", ONE_PIXEL_PNG_DATA_URI);
    unsigned.append("upload_preset", "anything");
    unsigned.append("public_id", "pwned");
    unsigned.append("type", type);

    for (const form of [signed, unsigned]) {
      const res = await app.request("/v1_1/test-cloud/image/upload", { method: "POST", body: form });
      expect(res.status).toBe(400);
    }

    expect(await Bun.file(join(escapeDir, "pwned.png")).exists()).toBe(false);
  });

  test("the known delivery types are still accepted", async () => {
    for (const type of ["upload", "private", "authenticated"]) {
      const form = new FormData();
      form.append("file", ONE_PIXEL_PNG_DATA_URI);
      form.append("upload_preset", "anything");
      form.append("public_id", `typed-${type}`);
      form.append("type", type);
      const res = await app.request("/v1_1/test-cloud/image/upload", { method: "POST", body: form });
      expect(res.status).toBe(200);
      expect(((await res.json()) as Record<string, unknown>)["type"]).toBe(type);
    }
  });
});

describe("delivery security headers (integration)", () => {
  let dataDir: string;
  let config: Config;
  let app: Hono;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-headers-test-"));
    config = {
      port: 0,
      dataDir,
      cloudName: "test-cloud",
      apiKey: "test-key",
      apiSecret: "test-secret",
      publicBaseUrl: undefined,
    };
    const store = await AssetStore.open(dataDir);
    app = createApp(config, store);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const upload = async (dataUri: string, publicId: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signParams({ public_id: publicId, timestamp }, config.apiSecret);
    const form = new FormData();
    form.append("file", dataUri);
    form.append("api_key", config.apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);
    form.append("public_id", publicId);
    const res = await app.request("/v1_1/test-cloud/image/upload", { method: "POST", body: form });
    const body = (await res.json()) as Record<string, unknown>;
    return new URL(body["url"] as string).pathname;
  };

  test("all delivered assets carry anti-sniffing and CSP headers", async () => {
    const path = await upload(ONE_PIXEL_PNG_DATA_URI, "safe-image");
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    // A plain raster image is safe to render inline.
    expect(res.headers.get("content-disposition")).toStartWith("inline");
  });

  test("an SVG is forced to download instead of rendering active content", async () => {
    const path = await upload(TINY_SVG_DATA_URI, "risky-vector");
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-disposition")).toStartWith("attachment");
  });
});
