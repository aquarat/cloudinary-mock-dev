import { appendFileSync } from "node:fs";

type Level = "info" | "warn" | "error";
type Fields = Record<string, string | number | boolean | undefined>;

let logFilePath: string | undefined;

/** Logs go to stdout/stderr (for `docker logs`) and, once configured, an append-only file under DATA_DIR — so an audit trail survives a container teardown/recreate even though the container itself is ephemeral. */
export function configureLogFile(path: string): void {
  logFilePath = path;
}

function formatFields(fields: Fields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, "_")}`)
    .join(" ");
}

function write(level: Level, event: string, fields: Fields): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${event} ${formatFields(fields)}`;

  if (level === "info") {
    console.log(line);
  } else {
    console.error(line);
  }

  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line + "\n");
    } catch (error) {
      console.error(`Failed writing to log file ${logFilePath}: ${(error as Error).message}`);
    }
  }
}

export const log = {
  info: (event: string, fields: Fields = {}) => write("info", event, fields),
  warn: (event: string, fields: Fields = {}) => write("warn", event, fields),
  error: (event: string, fields: Fields = {}) => write("error", event, fields),
};
