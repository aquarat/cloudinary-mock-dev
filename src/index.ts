import { join } from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { configureLogFile, log } from "./logger";
import { AssetStore } from "./store";

const config = loadConfig();
const store = await AssetStore.open(config.dataDir);
configureLogFile(join(config.dataDir, "access.log"));
const app = createApp(config, store);

log.info("startup", { port: config.port, cloud_name: config.cloudName, data_dir: config.dataDir });

export default {
  port: config.port,
  fetch: app.fetch,
};
