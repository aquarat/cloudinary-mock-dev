export type ResourceType = "image" | "video" | "raw";
export type DeliveryType = "upload" | "private" | "authenticated" | "fetch";

export interface AssetRecord {
  publicId: string;
  resourceType: ResourceType;
  type: DeliveryType;
  format: string;
  version: number;
  bytes: number;
  width: number | null;
  height: number | null;
  tags: string[];
  originalFilename: string | null;
  createdAt: string;
  /** Relative path under the data dir where the blob is stored. */
  storageKey: string;
}

export interface CloudinaryUploadResponse {
  asset_id: string;
  public_id: string;
  version: number;
  version_id: string;
  signature: string;
  width: number;
  height: number;
  format: string;
  resource_type: ResourceType;
  created_at: string;
  tags: string[];
  pages?: number;
  bytes: number;
  type: DeliveryType;
  etag: string;
  placeholder: false;
  url: string;
  secure_url: string;
  access_mode: string;
  original_filename: string | null;
  folder?: string;
}
