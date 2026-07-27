import type { MiddlewareHandler } from "hono";
import { clientIp } from "../clientIp";
import { log } from "../logger";
import { getRequestId } from "../requestContext";

export const requestLog: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  const durationMs = Math.round(performance.now() - start);
  log.info("http", {
    req_id: getRequestId(c),
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: durationMs,
    ip: clientIp(c),
  });
};
