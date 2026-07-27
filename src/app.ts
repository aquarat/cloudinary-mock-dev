import { Hono } from "hono";
import type { Config } from "./config";
import { requestId } from "./middleware/requestId";
import { requestLog } from "./middleware/requestLog";
import { createDeliveryRoute } from "./routes/delivery";
import { createDestroyRoute } from "./routes/destroy";
import { createHealthRoute } from "./routes/health";
import { createTagsRoute } from "./routes/tags";
import { createUploadRoute } from "./routes/upload";
import type { AssetStore } from "./store";

export function createApp(config: Config, store: AssetStore): Hono {
  const app = new Hono();
  app.use(requestId);
  app.use(requestLog);

  app.route("/", createHealthRoute());
  // Upload-API style routes (mimics api.cloudinary.com/v1_1/...).
  app.route("/", createUploadRoute(config, store));
  app.route("/", createDestroyRoute(config, store));
  app.route("/", createTagsRoute(config, store));
  // Delivery-CDN style routes (mimics res.cloudinary.com/<cloud_name>/...).
  app.route("/", createDeliveryRoute(config.cloudName, store));

  return app;
}
