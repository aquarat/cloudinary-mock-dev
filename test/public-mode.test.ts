import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { AssetStore } from "../src/store";
import { signParams } from "../src/signature";

let dir: string;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cloudinary-public-test-"));
  app = createApp(
    {
      port: 0,
      dataDir: dir,
      cloudName: "public-test",
      apiKey: "test-key",
      apiSecret: "test-secret",
      publicBaseUrl: "https://media.example.test",
      requireSignedUploads: true,
      corsOrigins: ["https://app.example.test"],
    },
    await AssetStore.open(dir),
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const upload = (params: Record<string, unknown>) =>
  app.request("/v1_1/public-test/image/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
const file =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("public mode rejects unsigned upload presets", async () => {
  expect((await upload({ file, upload_preset: "anything" })).status).toBe(401);
});
test("public mode accepts current signed uploads and rejects expired signatures", async () => {
  for (const [timestamp, status] of [
    [Date.now(), 200],
    [Math.floor(Date.now() / 1000), 200],
    [1, 401],
  ] as const) {
    const params = { timestamp };
    expect(
      (await upload({ ...params, file, api_key: "test-key", signature: signParams(params, "test-secret") })).status,
    ).toBe(status);
  }
});
test("CORS permits only configured browser origins", async () => {
  for (const origin of ["https://app.example.test", "https://untrusted.example.test"]) {
    const response = await app.request("/v1_1/public-test/image/upload", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(origin.includes("untrusted") ? null : origin);
  }
});
