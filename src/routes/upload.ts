import { type Context, Hono } from "hono";
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
const VALID_DELIVERY_TYPES = new Set<string>(["upload", "private", "authenticated", "fetch"]);

function detectResourceType(contentType: string | null): ResourceType {
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("image/")) return "image";
  return "raw";
}

export function createUploadRoute(config: Config, store: AssetStore): Hono {
  const app = new Hono();

  const handleUpload = async (c: Context, cloudName: string, requestedResourceType: string) => {
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

    if (config.requireSignedUploads) {
      const timestamp = Number(params["timestamp"]);
      const seconds = timestamp > 1e12 ? timestamp / 1000 : timestamp;
      if (!signature || !Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 3600) {
        authFailed("missing_or_expired_signature");
        return c.json({ error: { message: "A current signed upload is required." } }, 401);
      }
    }

    if (signature) {
      if (apiKey !== config.apiKey) {
        authFailed("invalid_api_key");
        return c.json({ error: { message: "Invalid api_key" } }, 401);
      }
      if (!verifySignature(params, signature, config.apiSecret)) {
        authFailed("invalid_signature");
        return c.json({ error: { message: "Invalid Signature." } }, 401);
      }
    } else if (!uploadPreset) {
      authFailed("missing_signature");
      return c.json({ error: { message: "Missing signature (and no upload_preset for an unsigned upload)." } }, 401);
    }

    let resolved;
    try {
      resolved = await resolveFileInput(params["file"]);
    } catch (error) {
      return c.json({ error: { message: (error as Error).message } }, 400);
    }

    const resourceType: ResourceType =
      requestedResourceType === "auto"
        ? detectResourceType(resolved.contentType)
        : (requestedResourceType as ResourceType);
    // `type` becomes a directory in the on-disk storage key below, so it must be
    // one of the known delivery types — an arbitrary value such as `../../x`
    // would otherwise write the blob outside the blobs directory.
    const requestedType = stringParam(params, "type") ?? "upload";
    if (!VALID_DELIVERY_TYPES.has(requestedType)) {
      return c.json({ error: { message: `Invalid type ${requestedType}` } }, 400);
    }
    const type = requestedType as DeliveryType;
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

    // `format` is attacker-influenced (via the `format` param / original filename)
    // and is concatenated into the on-disk storage key below. A value containing
    // `/`, `.`, `..` or null bytes could escape the blobs directory, so we require
    // a plain alphanumeric extension and reject anything else outright.
    if (!/^[a-zA-Z0-9]+$/.test(format)) {
      return c.json({ error: { message: `Invalid format ${format}` } }, 400);
    }

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
  };

  app.post("/v1_1/:cloudName/:resourceType{image|video|raw|auto}/upload", (c) => {
    const { cloudName, resourceType } = c.req.param();
    return handleUpload(c, cloudName, resourceType);
  });
  // Cloudinary also takes uploads without a resource type in the path, as an
  // image upload, and browser uploaders often post there.
  app.post("/v1_1/:cloudName/upload", (c) => handleUpload(c, c.req.param("cloudName"), "image"));

  return app;
}
