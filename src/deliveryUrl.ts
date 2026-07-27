import type { Context } from "hono";
import type { Config } from "./config";
import type { AssetRecord } from "./types";

function baseUrl(c: Context, config: Config): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const host = c.req.header("host") ?? `localhost:${config.port}`;
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export function buildDeliveryUrl(c: Context, config: Config, record: AssetRecord): string {
  return `${baseUrl(c, config)}/${config.cloudName}/${record.resourceType}/${record.type}/v${record.version}/${record.publicId}.${record.format}`;
}

/** A transformation segment is comma-joined `code_value` tokens, e.g. `c_fill,w_600,q_auto:good`. */
const TRANSFORMATION_SEGMENT_RE = /^([a-z]{1,4}_[^,/]+)(,[a-z]{1,4}_[^,/]+)*$/i;
const VERSION_SEGMENT_RE = /^v\d+$/;

export interface ParsedDeliveryPath {
  publicId: string;
  format: string | null;
}

/** Inverse of buildDeliveryUrl's path shape, tolerant of leading transformation/version segments. */
export function parseDeliveryPath(segments: string[]): ParsedDeliveryPath {
  let i = 0;
  while (i < segments.length - 1 && TRANSFORMATION_SEGMENT_RE.test(segments[i]!)) {
    i++;
  }
  if (i < segments.length - 1 && VERSION_SEGMENT_RE.test(segments[i]!)) {
    i++;
  }

  const rest = segments.slice(i);
  if (rest.length === 0) return { publicId: "", format: null };

  const last = rest[rest.length - 1]!;
  const dotIndex = last.lastIndexOf(".");
  const lastBase = dotIndex > 0 ? last.slice(0, dotIndex) : last;
  const format = dotIndex > 0 ? last.slice(dotIndex + 1) : null;

  const publicId = [...rest.slice(0, -1), lastBase].join("/");
  return { publicId, format };
}
