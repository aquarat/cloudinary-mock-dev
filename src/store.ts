import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssetRecord, DeliveryType, ResourceType } from "./types";

export class AssetStore {
  private readonly db: Database;

  constructor(private readonly dataDir: string) {
    this.db = new Database(join(dataDir, "assets.sqlite"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        resource_type TEXT NOT NULL,
        type TEXT NOT NULL,
        public_id TEXT NOT NULL,
        format TEXT NOT NULL,
        version INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        tags TEXT NOT NULL,
        original_filename TEXT,
        created_at TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        PRIMARY KEY (resource_type, type, public_id)
      );
    `);
  }

  static async open(dataDir: string): Promise<AssetStore> {
    await mkdir(dataDir, { recursive: true });
    return new AssetStore(dataDir);
  }

  blobPath(storageKey: string): string {
    return join(this.dataDir, "blobs", storageKey);
  }

  async writeBlob(storageKey: string, bytes: Uint8Array): Promise<void> {
    const path = this.blobPath(storageKey);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
  }

  async readBlob(storageKey: string): Promise<Uint8Array | undefined> {
    const file = Bun.file(this.blobPath(storageKey));
    if (!(await file.exists())) return undefined;
    return new Uint8Array(await file.arrayBuffer());
  }

  upsert(record: AssetRecord): void {
    this.db
      .query(
        `INSERT INTO assets (resource_type, type, public_id, format, version, bytes, width, height, tags, original_filename, created_at, storage_key)
         VALUES ($resourceType, $type, $publicId, $format, $version, $bytes, $width, $height, $tags, $originalFilename, $createdAt, $storageKey)
         ON CONFLICT (resource_type, type, public_id) DO UPDATE SET
           format = excluded.format,
           version = excluded.version,
           bytes = excluded.bytes,
           width = excluded.width,
           height = excluded.height,
           tags = excluded.tags,
           original_filename = excluded.original_filename,
           created_at = excluded.created_at,
           storage_key = excluded.storage_key`,
      )
      .run({
        $resourceType: record.resourceType,
        $type: record.type,
        $publicId: record.publicId,
        $format: record.format,
        $version: record.version,
        $bytes: record.bytes,
        $width: record.width,
        $height: record.height,
        $tags: JSON.stringify(record.tags),
        $originalFilename: record.originalFilename,
        $createdAt: record.createdAt,
        $storageKey: record.storageKey,
      });
  }

  find(resourceType: ResourceType, type: DeliveryType, publicId: string): AssetRecord | undefined {
    const row = this.db
      .query(
        `SELECT * FROM assets WHERE resource_type = $resourceType AND type = $type AND public_id = $publicId`,
      )
      .get({ $resourceType: resourceType, $type: type, $publicId: publicId }) as
      | Record<string, unknown>
      | null;
    return row ? rowToRecord(row) : undefined;
  }

  /** Cloudinary's delivery URLs don't encode `type`; `upload` is by far the common case, so search it first. */
  findByPublicIdAnyType(resourceType: ResourceType, publicId: string): AssetRecord | undefined {
    const row = this.db
      .query(
        `SELECT * FROM assets WHERE resource_type = $resourceType AND public_id = $publicId
         ORDER BY (type = 'upload') DESC LIMIT 1`,
      )
      .get({ $resourceType: resourceType, $publicId: publicId }) as Record<string, unknown> | null;
    return row ? rowToRecord(row) : undefined;
  }

  setTags(resourceType: ResourceType, publicId: string, tags: string[]): AssetRecord | undefined {
    this.db
      .query(
        `UPDATE assets SET tags = $tags WHERE resource_type = $resourceType AND public_id = $publicId`,
      )
      .run({ $tags: JSON.stringify(tags), $resourceType: resourceType, $publicId: publicId });
    return this.findByPublicIdAnyType(resourceType, publicId);
  }

  async destroy(resourceType: ResourceType, type: DeliveryType, publicId: string): Promise<boolean> {
    const record = this.find(resourceType, type, publicId);
    if (!record) return false;
    this.db
      .query(`DELETE FROM assets WHERE resource_type = $resourceType AND type = $type AND public_id = $publicId`)
      .run({ $resourceType: resourceType, $type: type, $publicId: publicId });
    await Bun.file(this.blobPath(record.storageKey)).delete().catch(() => {});
    return true;
  }
}

function rowToRecord(row: Record<string, unknown>): AssetRecord {
  return {
    resourceType: row["resource_type"] as ResourceType,
    type: row["type"] as DeliveryType,
    publicId: row["public_id"] as string,
    format: row["format"] as string,
    version: row["version"] as number,
    bytes: row["bytes"] as number,
    width: (row["width"] as number | null) ?? null,
    height: (row["height"] as number | null) ?? null,
    tags: JSON.parse(row["tags"] as string),
    originalFilename: (row["original_filename"] as string | null) ?? null,
    createdAt: row["created_at"] as string,
    storageKey: row["storage_key"] as string,
  };
}
