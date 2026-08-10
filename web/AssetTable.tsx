import { useState } from "react";
import type { AdminAsset, SortKey, SortOrder } from "./api";
import { formatBytes, formatDate, formatDimensions } from "./format";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "date", label: "Created" },
];

function SortableHeader({
  column,
  sort,
  order,
  onSort,
}: {
  column: { key: SortKey; label: string };
  sort: SortKey;
  order: SortOrder;
  onSort: (key: SortKey) => void;
}) {
  const active = sort === column.key;
  return (
    <th aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={active ? "sort active" : "sort"} onClick={() => onSort(column.key)}>
        {column.label}
        <span aria-hidden="true"> {active ? (order === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

/**
 * Only inert raster images render inline: the delivery route sends everything
 * else (SVG, PDF, video, raw) as `Content-Disposition: attachment` under a
 * sandboxing CSP, so an <img> for those would either download or break. The
 * server flags what is safe via `previewable`; the rest gets a format chip.
 */
function Preview({ asset }: { asset: AdminAsset }) {
  const [failed, setFailed] = useState(false);

  if (!asset.previewable || failed) {
    return (
      <div className="thumb placeholder" title="No inline preview for this type">
        <span>{(asset.format || asset.resource_type || "?").toUpperCase()}</span>
      </div>
    );
  }
  return (
    <a className="thumb" href={asset.url} target="_blank" rel="noreferrer noopener">
      <img src={asset.url} alt={asset.public_id} loading="lazy" onError={() => setFailed(true)} />
    </a>
  );
}

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="muted">—</span>;
  return (
    <span className="tags">
      {tags.map((tag) => (
        <span className="tag" key={tag}>
          {tag}
        </span>
      ))}
    </span>
  );
}

export function AssetTable({
  assets,
  sort,
  order,
  onSort,
  onDelete,
  pendingDelete,
  selected,
  onToggleOne,
  onTogglePage,
}: {
  assets: AdminAsset[];
  sort: SortKey;
  order: SortOrder;
  onSort: (key: SortKey) => void;
  onDelete: (asset: AdminAsset) => void;
  pendingDelete: string | null;
  selected: ReadonlySet<string>;
  onToggleOne: (asset: AdminAsset, checked: boolean) => void;
  onTogglePage: (checked: boolean) => void;
}) {
  // Two-step delete: the first click arms this row, the second confirms.
  const [confirming, setConfirming] = useState<string | null>(null);
  const rowKey = (asset: AdminAsset) => `${asset.resource_type}/${asset.type}/${asset.public_id}`;

  const selectedOnPage = assets.filter((asset) => selected.has(rowKey(asset))).length;
  const allOnPageSelected = assets.length > 0 && selectedOnPage === assets.length;

  return (
    <table className="assets">
      <thead>
        <tr>
          <th className="select">
            <input
              type="checkbox"
              aria-label={allOnPageSelected ? "Deselect all on this page" : "Select all on this page"}
              checked={allOnPageSelected}
              // Some-but-not-all selected reads as a dash rather than a tick.
              ref={(el) => {
                if (el) el.indeterminate = selectedOnPage > 0 && !allOnPageSelected;
              }}
              disabled={assets.length === 0}
              onChange={(e) => onTogglePage(e.target.checked)}
            />
          </th>
          <th>Preview</th>
          {COLUMNS.slice(0, 1).map((column) => (
            <SortableHeader key={column.key} column={column} sort={sort} order={order} onSort={onSort} />
          ))}
          <th>Format</th>
          <th>Dimensions</th>
          {COLUMNS.slice(1).map((column) => (
            <SortableHeader key={column.key} column={column} sort={sort} order={order} onSort={onSort} />
          ))}
          <th>Tags</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {assets.length === 0 ? (
          <tr>
            <td colSpan={9} className="muted empty">
              No assets.
            </td>
          </tr>
        ) : null}
        {assets.map((asset) => {
          const key = rowKey(asset);
          const armed = confirming === key;
          const isSelected = selected.has(key);
          return (
            <tr key={key} className={isSelected ? "selected" : undefined}>
              <td className="select">
                <input
                  type="checkbox"
                  aria-label={`Select ${asset.public_id}`}
                  checked={isSelected}
                  onChange={(e) => onToggleOne(asset, e.target.checked)}
                />
              </td>
              <td>
                <Preview asset={asset} />
              </td>
              <td className="id">
                {asset.public_id}
                <div className="muted small">
                  {asset.resource_type}/{asset.type}
                </div>
              </td>
              <td>{asset.format || "—"}</td>
              <td>{formatDimensions(asset.width, asset.height)}</td>
              <td>{formatBytes(asset.bytes)}</td>
              <td>{formatDate(asset.created_at)}</td>
              <td>
                <Tags tags={asset.tags} />
              </td>
              <td className="actions">
                {armed ? (
                  <>
                    <button
                      type="button"
                      className="danger"
                      disabled={pendingDelete === key}
                      onClick={() => {
                        setConfirming(null);
                        onDelete(asset);
                      }}
                    >
                      {pendingDelete === key ? "Deleting…" : "Confirm"}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="danger" onClick={() => setConfirming(key)}>
                    Delete
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
