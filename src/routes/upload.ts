import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { clientIp } from "../clientIp";
import type { Config } from "../config";
import { buildDeliveryUrl } from "../deliveryUrl";
import { resolveFileInput } from "../fileInput";
import { resolvePublicId } from "../idgen";
import { log } from "../logger";
import { inspectMedia } from "../mediaInspect";
import { parseParams, stringParam, tagsParam } from "../parseParams";
import { getRequestId } from "../requestContext";
import { signParams, verifySignature } from "../signature";
import type { AssetStore } from "../store";
import type { CloudinaryUploadResponse, DeliveryType, ResourceType } from "../types";

const VALID_RESOURCE_TYPES = new Set(["image", "video", "raw", "auto"]);

function detectResourceType(contentType: string | null): ResourceType {
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("image/")) return "image";
  return "raw";
}

export function createUploadRoute(config: Config, store: AssetStore): Hono {
  const app = new Hono();

  app.post("/v1_1/:cloudName/:resourceType{image|video|raw|auto}/upload", async (c) => {
    const { cloudName, resourceType: requestedResourceType } = c.req.param();
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
    if (!VALID_RESOURCE_TYPES.has(requestedResourceType)) {
      return c.json({ error: { message: `Invalid resource_type ${requestedResourceType}` } }, 400);
    }

    let params;
    try {
      params = await parseParams(c);
    } catch (error) {
      return c.json({ error: { message: `Could not parse upload body: ${(error as Error).message}` } }, 400);
    }

    const apiKey = stringParam(params, "api_key");
    const signature = stringParam(params, "signature");
    const uploadPreset = stringParam(params, "upload_preset");

    if (signature) {
      if (apiKey !== config.apiKey) {
        authFailed("invalid_api_key", apiKey);
        return c.json({ error: { message: "Invalid api_key" } }, 401);
      }
      if (!verifySignature(params, signature, config.apiSecret)) {
        authFailed("invalid_signature", apiKey);
        return c.json({ error: { message: "Invalid Signature." } }, 401);
      }
    } else if (!uploadPreset) {
      authFailed("missing_signature", apiKey);
      return c.json({ error: { message: "Missing signature (and no upload_preset for an unsigned upload)." } }, 401);
    }

    let resolved;
    try {
      resolved = await resolveFileInput(params["file"]);
    } catch (error) {
      return c.json({ error: { message: (error as Error).message } }, 400);
    }

    const resourceType: ResourceType =
      requestedResourceType === "auto" ? detectResourceType(resolved.contentType) : (requestedResourceType as ResourceType);
    const type: DeliveryType = (stringParam(params, "type") as DeliveryType | undefined) ?? "upload";
    const folder = stringParam(params, "folder");
    const requestedPublicId = stringParam(params, "public_id");
    const publicId = resolvePublicId({ publicId: requestedPublicId, folder });

    const { format, width, height } = inspectMedia({
      resourceType,
      bytes: resolved.bytes,
      originalFilename: resolved.originalFilename,
      contentType: resolved.contentType,
      requestedFormat: stringParam(params, "format"),
    });

    const version = Math.floor(Date.now() / 1000);
    const storageKey = `${resourceType}/${type}/${publicId}.${format}`;

    await store.writeBlob(storageKey, resolved.bytes);
    store.upsert({
      publicId,
      resourceType,
      type,
      format,
      version,
      bytes: resolved.bytes.byteLength,
      width,
      height,
      tags: tagsParam(params),
      originalFilename: resolved.originalFilename,
      createdAt: new Date().toISOString(),
      storageKey,
    });

    const record = store.find(resourceType, type, publicId)!;

    const url = buildDeliveryUrl(c, config, record);
    const secureUrl = url;

    const responseSignature = signParams({ public_id: publicId, version }, config.apiSecret);

    const body: CloudinaryUploadResponse = {
      asset_id: randomBytes(16).toString("hex"),
      public_id: publicId,
      version,
      version_id: randomBytes(12).toString("hex"),
      signature: responseSignature,
      width: width ?? 0,
      height: height ?? 0,
      format,
      resource_type: resourceType,
      created_at: record.createdAt,
      tags: record.tags,
      bytes: record.bytes,
      type,
      etag: randomBytes(16).toString("hex"),
      placeholder: false,
      url,
      secure_url: secureUrl,
      access_mode: "public",
      original_filename: resolved.originalFilename,
      ...(folder ? { folder } : {}),
    };

    log.info("upload", {
      req_id: getRequestId(c),
      ip: clientIp(c),
      public_id: publicId,
      resource_type: resourceType,
      bytes: record.bytes,
      folder,
    });

    return c.json(body, 200);
  });

  return app;
}
