import { Hono } from "hono";
import { clientIp } from "../clientIp";
import type { Config } from "../config";
import { log } from "../logger";
import { parseParams, stringParam } from "../parseParams";
import { getRequestId } from "../requestContext";
import { verifySignature } from "../signature";
import type { AssetStore } from "../store";
import type { DeliveryType, ResourceType } from "../types";

export function createDestroyRoute(config: Config, store: AssetStore): Hono {
  const app = new Hono();

  app.post("/v1_1/:cloudName/:resourceType{image|video|raw}/destroy", async (c) => {
    const { cloudName, resourceType } = c.req.param();
    const authFailed = (reason: string) => {
      log.warn("auth_failed", {
        req_id: getRequestId(c),
        reason,
        ip: clientIp(c),
        cloud_name: cloudName,
      });
    };

    if (cloudName !== config.cloudName) {
      authFailed("invalid_cloud_name");
      return c.json({ error: { message: `Invalid cloud_name ${cloudName}` } }, 401);
    }

    const params = await parseParams(c);
    const apiKey = stringParam(params, "api_key");
    const signature = stringParam(params, "signature");
    const publicId = stringParam(params, "public_id");

    if (!signature || apiKey !== config.apiKey || !verifySignature(params, signature, config.apiSecret)) {
      authFailed("invalid_signature");
      return c.json({ error: { message: "Invalid Signature." } }, 401);
    }
    if (!publicId) {
      return c.json({ error: { message: "Missing public_id" } }, 400);
    }

    const type = (stringParam(params, "type") as DeliveryType | undefined) ?? "upload";
    const deleted = await store.destroy(resourceType as ResourceType, type, publicId);

    log.info("destroy", {
      req_id: getRequestId(c),
      ip: clientIp(c),
      public_id: publicId,
      resource_type: resourceType,
      deleted,
    });

    return c.json({ result: deleted ? "ok" : "not found" }, 200);
  });

  return app;
}
