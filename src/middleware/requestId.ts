import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { setRequestId } from "../requestContext";

export const requestId: MiddlewareHandler = async (c, next) => {
  setRequestId(c, randomBytes(4).toString("hex"));
  await next();
};
