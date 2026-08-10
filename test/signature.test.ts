import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { signParams, verifySignature } from "../src/signature";

describe("signParams", () => {
  test("matches a hand-built sha1(sorted `key=value&...` + secret) digest", () => {
    const expected = createHash("sha1").update("public_id=sample&timestamp=1315060820abcd").digest("hex");
    const signature = signParams({ public_id: "sample", timestamp: 1315060820 }, "abcd", "sha1");
    expect(signature).toBe(expected);
  });

  test("ignores excluded params and empty values", () => {
    const a = signParams({ folder: "x", timestamp: 1, file: "should-be-ignored" }, "secret");
    const b = signParams({ folder: "x", timestamp: 1, api_key: "should-be-ignored" }, "secret");
    const c = signParams({ folder: "x", timestamp: 1, extra: "" }, "secret");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test("is order-independent", () => {
    const a = signParams({ folder: "x", timestamp: 1, tags: "a" }, "secret");
    const b = signParams({ tags: "a", timestamp: 1, folder: "x" }, "secret");
    expect(a).toBe(b);
  });
});

describe("verifySignature", () => {
  test("accepts a correct sha1 signature", () => {
    const params = { public_id: "sample", timestamp: 1315060820 };
    const signature = signParams(params, "abcd", "sha1");
    expect(verifySignature(params, signature, "abcd")).toBe(true);
  });

  test("accepts a correct sha256 signature", () => {
    const params = { public_id: "sample", timestamp: 1315060820 };
    const signature = signParams(params, "abcd", "sha256");
    expect(verifySignature(params, signature, "abcd")).toBe(true);
  });

  test("rejects a tampered signature", () => {
    const params = { public_id: "sample", timestamp: 1315060820 };
    expect(verifySignature(params, "deadbeef", "abcd")).toBe(false);
  });
});
