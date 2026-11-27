import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { clientIp } from "../src/clientIp";

const app = new Hono();
app.get("/ip", (c) => c.text(clientIp(c)));

describe("clientIp", () => {
  test("a direct request is identified by its socket address", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/ip`);
      expect(await res.text()).toBe("127.0.0.1");
    } finally {
      await server.stop(true);
    }
  });

  test("proxy headers take precedence, Cloudflare's first", async () => {
    const forwarded = await app.request("/ip", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
    expect(await forwarded.text()).toBe("203.0.113.7");

    const cloudflare = await app.request("/ip", {
      headers: { "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "203.0.113.7" },
    });
    expect(await cloudflare.text()).toBe("198.51.100.9");
  });

  test("falls back to `unknown` when there is no server to ask", async () => {
    const res = await app.request("/ip");
    expect(await res.text()).toBe("unknown");
  });
});
