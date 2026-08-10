import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { signParams } from "../src/signature";
import { AssetStore } from "../src/store";

describe("tags route — Ruby gem wire format", () => {
  let dataDir: string;
  let config: Config;
  let app: Hono;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cloudinary-mock-dev-tags-test-"));
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

  // `Cloudinary::Uploader.remove_all_tags` POSTs array params under
  // bracketed field names (`public_ids[]=...`, one field per element) but
  // computes the signature over the bare name with values comma-joined
  // (`public_ids=a,b`). The clone must accept that combination.
  test("accepts remove_all with bracketed public_ids[] fields signed under the bare key", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const publicIds = ["gallery/asset-one", "gallery/asset-two"];
    const signature = signParams({ command: "remove_all", public_ids: publicIds, timestamp }, config.apiSecret);

    const form = new FormData();
    form.append("command", "remove_all");
    for (const id of publicIds) form.append("public_ids[]", id);
    form.append("timestamp", String(timestamp));
    form.append("api_key", config.apiKey);
    form.append("signature", signature);

    const res = await app.request("/v1_1/test-cloud/image/tags", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { public_ids: string[] };
    expect(body.public_ids).toEqual(publicIds);
  });

  test("accepts a single bracketed public_ids[] field (one-element array)", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signParams(
      { command: "remove_all", public_ids: ["gallery/only-one"], timestamp },
      config.apiSecret,
    );

    const form = new FormData();
    form.append("command", "remove_all");
    form.append("public_ids[]", "gallery/only-one");
    form.append("timestamp", String(timestamp));
    form.append("api_key", config.apiKey);
    form.append("signature", signature);

    const res = await app.request("/v1_1/test-cloud/image/tags", { method: "POST", body: form });
    expect(res.status).toBe(200);
  });

  test("still rejects a genuinely bad signature", async () => {
    const form = new FormData();
    form.append("command", "remove_all");
    form.append("public_ids[]", "gallery/whatever");
    form.append("timestamp", String(Math.floor(Date.now() / 1000)));
    form.append("api_key", config.apiKey);
    form.append("signature", "deadbeef");

    const res = await app.request("/v1_1/test-cloud/image/tags", { method: "POST", body: form });
    expect(res.status).toBe(401);
  });
});
