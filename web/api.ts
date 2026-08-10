/** Client for the /admin/api endpoints. Mirrors the JSON shapes in src/routes/admin.ts. */

import type { SortKey, SortOrder } from "./types";

export type { SortKey, SortOrder };

export interface AdminAsset {
  public_id: string;
  resource_type: string;
  type: string;
  format: string;
  bytes: number;
  width: number | null;
  height: number | null;
  tags: string[];
  created_at: string;
  version: number;
  url: string;
  previewable: boolean;
}

export interface AssetListResponse {
  assets: AdminAsset[];
  total: number;
  limit: number;
  offset: number;
  sort: SortKey;
  order: SortOrder;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export async function login(username: string, password: string): Promise<string> {
  const res = await fetch("/admin/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new ApiError(await readError(res, "Login failed"), res.status);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function authedJson<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new ApiError(await readError(res, `Request failed (${res.status})`), res.status);
  }
  return (await res.json()) as T;
}

export interface ListQuery {
  sort: SortKey;
  order: SortOrder;
  filter: string;
  limit: number;
  offset: number;
}

export function listAssets(token: string, query: ListQuery): Promise<AssetListResponse> {
  const params = new URLSearchParams({
    sort: query.sort,
    order: query.order,
    limit: String(query.limit),
    offset: String(query.offset),
  });
  if (query.filter.trim() !== "") params.set("q", query.filter.trim());
  return authedJson<AssetListResponse>(token, `/admin/api/assets?${params.toString()}`);
}

export function deleteAsset(token: string, asset: AdminAsset): Promise<{ deleted: boolean }> {
  return authedJson<{ deleted: boolean }>(token, "/admin/api/assets/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resource_type: asset.resource_type,
      type: asset.type,
      public_id: asset.public_id,
    }),
  });
}

/** Identity triple the bulk endpoint needs — far smaller than a whole AdminAsset to hold in selection state. */
export interface AssetRef {
  resource_type: string;
  type: string;
  public_id: string;
}

export interface BulkDeleteResult {
  deleted: number;
  /** Still matching after this batch; only meaningful in filter mode. */
  remaining: number;
}

/** The server caps a bulk request; the caller chunks to this size. */
export const BULK_DELETE_BATCH = 500;

export function bulkDeleteAssets(token: string, assets: AssetRef[]): Promise<BulkDeleteResult> {
  return authedJson<BulkDeleteResult>(token, "/admin/api/assets/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assets }),
  });
}

/** Deletes one bounded batch of everything matching `filter`; loop while `remaining > 0`. */
export function bulkDeleteMatching(token: string, filter: string): Promise<BulkDeleteResult> {
  return authedJson<BulkDeleteResult>(token, "/admin/api/assets/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ all_matching: true, ...(filter.trim() === "" ? {} : { q: filter.trim() }) }),
  });
}

/** Clears the server-side session cookie. Best-effort: the local token is dropped regardless. */
export async function logout(token: string): Promise<void> {
  try {
    await authedJson(token, "/admin/api/logout", { method: "POST" });
  } catch {
    /* signing out locally is what matters */
  }
}

const TOKEN_KEY = "cloudinary-clone-admin-token";

/** localStorage may be unavailable (private mode / disabled storage); a lost session is preferable to a crash. */
export function loadStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore — the in-memory token still works for this page load */
  }
}
