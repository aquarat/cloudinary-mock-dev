import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { signParams } from "../src/signature";
import { AssetStore } from "../src/store";

// A well-known 1x1 transparent PNG, used as a minimal but real image payload.
const ONE_PIXEL_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("upload / delivery / tags / destroy", () => {
  let dataDir: string;
  let config: Config;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  // A real listening server (not just an in-process request()) is needed
  // because "upload by remote URL" makes this process fetch() a delivery URL
  // over the network, same as the real Cloudinary API fetching a source image.
  beforeAll(async () => {
    // The "upload by remote URL" test re-fetches an asset from http://localhost:<port>.
    // Loopback is otherwise SSRF-blocked, so allowlist it explicitly for the suite.
    process.env["SSRF_ALLOWED_HOSTS"] = "localhost";
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-test-"));
    config = {
      port: 0,
      dataDir,
      cloudName: "test-cloud",
      apiKey: "test-key",
      apiSecret: "test-secret",
      publicBaseUrl: undefined,
    };
    const store = await AssetStore.open(dataDir);
    const app = createApp(config, store);
    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  });

  const request = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);

  test("rejects an upload with a bad signature", async () => {
    const form = new FormData();
    form.append("file", ONE_PIXEL_PNG_DATA_URI);
    form.append("api_key", config.apiKey);
    form.append("timestamp", "1");
    form.append("signature", "not-a-real-signature");

    const res = await request("/v1_1/test-cloud/image/upload", { method: "POST", body: form });
    expect(res.status).toBe(401);
  });

  test("uploads by data URI, then serves the asset back over the delivery route", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = "gallery";
    const signature = signParams({ folder, timestamp }, config.apiSecret);

    const form = new FormData();
    form.append("file", ONE_PIXEL_PNG_DATA_URI);
    form.append("api_key", config.apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);
    form.append("folder", folder);

    const uploadRes = await request("/v1_1/test-cloud/image/upload", { method: "POST", body: form });
    expect(uploadRes.status).toBe(200);
    const body = (await uploadRes.json()) as Record<string, unknown>;

    expect(body["public_id"]).toStartWith("gallery/");
    expect(body["format"]).toBe("png");
    expect(body["width"]).toBe(1);
    expect(body["height"]).toBe(1);
    expect(body["resource_type"]).toBe("image");

    const deliveryPath = new URL(body["url"] as string).pathname;
    const deliveryRes = await request(deliveryPath);
    expect(deliveryRes.status).toBe(200);
    expect(deliveryRes.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await deliveryRes.arrayBuffer());
    expect(bytes.byteLength).toBe(body["bytes"] as number);
  });

  test("uploads by remote URL and honors an explicit public_id", async () => {
    // Reuses the previously-uploaded asset's own delivery URL as the "remote" source.
    const timestamp = Math.floor(Date.now() / 1000);
    const firstSignature = signParams({ folder: "src", timestamp }, config.apiSecret);
    const firstForm = new FormData();
    firstForm.append("file", ONE_PIXEL_PNG_DATA_URI);
    firstForm.append("api_key", config.apiKey);
    firstForm.append("timestamp", String(timestamp));
    firstForm.append("signature", firstSignature);
    firstForm.append("folder", "src");
    const firstRes = await request("/v1_1/test-cloud/image/upload", { method: "POST", body: firstForm });
    const firstBody = (await firstRes.json()) as Record<string, unknown>;
    const remoteUrl = firstBody["url"] as string;

    const publicId = "explicit-id";
    const secondTimestamp = Math.floor(Date.now() / 1000);
    const secondSignature = signParams({ public_id: publicId, timestamp: secondTimestamp }, config.apiSecret);
    const secondForm = new FormData();
    secondForm.append("file", remoteUrl);
    secondForm.append("api_key", config.apiKey);
    secondForm.append("timestamp", String(secondTimestamp));
    secondForm.append("signature", secondSignature);
    secondForm.append("public_id", publicId);

    const secondRes = await request("/v1_1/test-cloud/image/upload", { method: "POST", body: secondForm });
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as Record<string, unknown>;
    expect(secondBody["public_id"]).toBe(publicId);
    expect(secondBody["bytes"]).toBe(firstBody["bytes"]);
  });

  test("remove_all_tags clears tags (delete-time call)", async () => {
    const uploadTimestamp = Math.floor(Date.now() / 1000);
    const publicId = "tagged-asset";
    const uploadSignature = signParams(
      { public_id: publicId, tags: "keep-me", timestamp: uploadTimestamp },
      config.apiSecret,
    );
    const uploadForm = new FormData();
    uploadForm.append("file", ONE_PIXEL_PNG_DATA_URI);
    uploadForm.append("api_key", config.apiKey);
    uploadForm.append("timestamp", String(uploadTimestamp));
    uploadForm.append("signature", uploadSignature);
    uploadForm.append("public_id", publicId);
    uploadForm.append("tags", "keep-me");
    const uploadRes = await request("/v1_1/test-cloud/image/upload", { method: "POST", body: uploadForm });
    expect(((await uploadRes.json()) as Record<string, unknown>)["tags"]).toEqual(["keep-me"]);

    const tagsTimestamp = Math.floor(Date.now() / 1000);
    const tagsSignature = signParams(
      { command: "remove_all", public_ids: [publicId], timestamp: tagsTimestamp },
      config.apiSecret,
    );
    const tagsForm = new FormData();
    tagsForm.append("api_key", config.apiKey);
    tagsForm.append("timestamp", String(tagsTimestamp));
    tagsForm.append("signature", tagsSignature);
    tagsForm.append("command", "remove_all");
    tagsForm.append("public_ids", publicId);

    const tagsRes = await request("/v1_1/test-cloud/image/tags", { method: "POST", body: tagsForm });
    expect(tagsRes.status).toBe(200);
    expect(await tagsRes.json()).toEqual({ public_ids: [publicId] });
  });

  test("destroy removes the asset so delivery 404s afterwards", async () => {
    const uploadTimestamp = Math.floor(Date.now() / 1000);
    const publicId = "to-be-destroyed";
    const uploadSignature = signParams({ public_id: publicId, timestamp: uploadTimestamp }, config.apiSecret);
    const uploadForm = new FormData();
    uploadForm.append("file", ONE_PIXEL_PNG_DATA_URI);
    uploadForm.append("api_key", config.apiKey);
    uploadForm.append("timestamp", String(uploadTimestamp));
    uploadForm.append("signature", uploadSignature);
    uploadForm.append("public_id", publicId);
    const uploadRes = await request("/v1_1/test-cloud/image/upload", { method: "POST", body: uploadForm });
    const uploadBody = (await uploadRes.json()) as Record<string, unknown>;
    const deliveryPath = new URL(uploadBody["url"] as string).pathname;

    const destroyTimestamp = Math.floor(Date.now() / 1000);
    const destroySignature = signParams({ public_id: publicId, timestamp: destroyTimestamp }, config.apiSecret);
    const destroyForm = new FormData();
    destroyForm.append("api_key", config.apiKey);
    destroyForm.append("timestamp", String(destroyTimestamp));
    destroyForm.append("signature", destroySignature);
    destroyForm.append("public_id", publicId);

    const destroyRes = await request("/v1_1/test-cloud/image/destroy", { method: "POST", body: destroyForm });
    expect(destroyRes.status).toBe(200);
    expect(await destroyRes.json()).toEqual({ result: "ok" });

    const deliveryRes = await request(deliveryPath);
    expect(deliveryRes.status).toBe(404);
  });
});
