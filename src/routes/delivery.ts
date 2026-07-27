import { Hono } from "hono";
import { mimeForFormat } from "../contentType";
import { parseDeliveryPath } from "../deliveryUrl";
import type { AssetStore } from "../store";
import type { DeliveryType, ResourceType } from "../types";

const RESOURCE_TYPES: ResourceType[] = ["image", "video", "raw"];
const DELIVERY_TYPES: DeliveryType[] = ["upload", "private", "authenticated", "fetch"];

/** Mimics `res.cloudinary.com/<cloud_name>/<resource_type>/<type>/[transformations/][vN/]<public_id>.<format>`. */
export function createDeliveryRoute(cloudName: string, store: AssetStore): Hono {
  const app = new Hono();

  app.get("/:cloudName/:resourceType/:type/*", async (c) => {
    const { cloudName: requestedCloudName, resourceType, type } = c.req.param();
    if (
      requestedCloudName !== cloudName ||
      !RESOURCE_TYPES.includes(resourceType as ResourceType) ||
      !DELIVERY_TYPES.includes(type as DeliveryType)
    ) {
      return c.notFound();
    }

    const fullPath = c.req.path.split("/").filter(Boolean);
    // fullPath = [cloudName, resourceType, type, ...rest]
    const rest = fullPath.slice(3);
    const { publicId } = parseDeliveryPath(rest);
    if (!publicId) return c.notFound();

    const record =
      store.find(resourceType as ResourceType, type as DeliveryType, publicId) ??
      store.findByPublicIdAnyType(resourceType as ResourceType, publicId);
    if (!record) return c.notFound();

    const bytes = await store.readBlob(record.storageKey);
    if (!bytes) return c.notFound();

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": mimeForFormat(record.format),
        "Content-Length": String(bytes.byteLength),
        // Transformations in the request path are accepted but ignored — this
        // always serves the originally-uploaded bytes. See README limitations.
        "Cache-Control": "no-store",
      },
    });
  });

  return app;
}
