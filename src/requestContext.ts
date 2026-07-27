import type { Context } from "hono";

/** Short per-request id so a route's detail log lines (e.g. `auth_failed`, `upload`) can be correlated with the generic `http` access-log line for the same request. */
export function setRequestId(c: Context, id: string): void {
  c.set("requestId", id);
}

export function getRequestId(c: Context): string {
  return (c.get("requestId") as string | undefined) ?? "-";
}
