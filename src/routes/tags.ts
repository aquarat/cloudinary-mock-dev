import { Hono } from "hono";
import { clientIp } from "../clientIp";
import type { Config } from "../config";
import { log } from "../logger";
import { arrayParam, parseParams, stringParam } from "../parseParams";
import { getRequestId } from "../requestContext";
import { verifySignature } from "../signature";
import type { AssetStore } from "../store";
import type { ResourceType } from "../types";

type TagCommand = "add" | "remove" | "replace" | "remove_all";

function applyCommand(existing: string[], command: TagCommand, tag: string | undefined): string[] {
  switch (command) {
    case "add":
      return tag && !existing.includes(tag) ? [...existing, tag] : existing;
    case "remove":
      return tag ? existing.filter((t) => t !== tag) : existing;
    case "replace":
      return tag ? [tag] : [];
    case "remove_all":
      return [];
  }
}

/** Matches `Cloudinary::Uploader.{add,remove,remove_all,replace}_tags`, which all POST here. */
export function createTagsRoute(config: Config, store: AssetStore): Hono {
  const app = new Hono();

  app.post("/v1_1/:cloudName/:resourceType{image|video|raw}/tags", async (c) => {
    const { cloudName, resourceType } = c.req.param();
    const authFailed = (reason: string, apiKey?: string) => {
      log.warn("auth_failed", {
        req_id: getRequestId(c),
        reason,
        ip: clientIp(c),
        cloud_name: cloudName,
        api_key: apiKey,
      });
    };

    if (cloudName !== config.cloudName) {
      authFailed("invalid_cloud_name");
      return c.json({ error: { message: `Invalid cloud_name ${cloudName}` } }, 401);
    }

    const params = await parseParams(c);
    const apiKey = stringParam(params, "api_key");
    const signature = stringParam(params, "signature");

    if (!signature || apiKey !== config.apiKey || !verifySignature(params, signature, config.apiSecret)) {
      authFailed("invalid_signature", apiKey);
      return c.json({ error: { message: "Invalid Signature." } }, 401);
    }

    const command = stringParam(params, "command") as TagCommand | undefined;
    if (!command) {
      return c.json({ error: { message: "Missing command" } }, 400);
    }
    const tag = stringParam(params, "tag");
    const publicIds = arrayParam(params, "public_ids");
    if (publicIds.length === 0) {
      return c.json({ error: { message: "Missing public_ids" } }, 400);
    }

    for (const publicId of publicIds) {
      const existing = store.findByPublicIdAnyType(resourceType as ResourceType, publicId);
      if (!existing) continue;
      store.setTags(resourceType as ResourceType, publicId, applyCommand(existing.tags, command, tag));
    }

    log.info("tags", {
      req_id: getRequestId(c),
      ip: clientIp(c),
      command,
      resource_type: resourceType,
      public_ids: publicIds.join(","),
    });

    return c.json({ public_ids: publicIds }, 200);
  });

  return app;
}
