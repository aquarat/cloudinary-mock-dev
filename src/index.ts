import { join } from "node:path";
import { createApp } from "./app";
import { loadConfig, validateConfig } from "./config";
import { configureLogFile, log } from "./logger";
import { AssetStore } from "./store";

const config = loadConfig();

// Refuse to boot on the committed default credentials unless dev mode is opted
// into — otherwise anyone could forge signatures against an exposed instance.
const credentials = validateConfig(config);
if (credentials.fatal) {
  log.error("startup_aborted", {
    reason: "default_credentials",
    default_vars: credentials.defaults.join(","),
    hint: "set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET (or set ALLOW_DEFAULT_CREDENTIALS=1 for local dev)",
  });
  process.exit(1);
} else if (credentials.defaults.length > 0) {
  log.warn("insecure_credentials", {
    default_vars: credentials.defaults.join(","),
    hint: "using built-in default credentials — do not expose this instance publicly",
  });
}

const store = await AssetStore.open(config.dataDir);
configureLogFile(join(config.dataDir, "access.log"));
const app = createApp(config, store);

log.info("startup", {
  port: config.port,
  cloud_name: config.cloudName,
  data_dir: config.dataDir,
  delivery_fallback: (config.deliveryFallbackUrls ?? []).join(",") || "off",
});

export default {
  port: config.port,
  fetch: app.fetch,
};
