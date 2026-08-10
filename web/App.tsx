import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  BULK_DELETE_BATCH,
  bulkDeleteAssets,
  bulkDeleteMatching,
  deleteAsset,
  listAssets,
  loadStoredToken,
  logout,
  storeToken,
  type AdminAsset,
  type AssetRef,
  type SortKey,
  type SortOrder,
} from "./api";
import { AssetTable } from "./AssetTable";
import { Login } from "./Login";
import { PAGE_SIZES, readViewState, viewStateToSearch, type PageSize } from "./urlState";

/** Typing in the search box shouldn't fire a request per keystroke — especially at 5000 rows a page. */
const FILTER_DEBOUNCE_MS = 300;

const assetKey = (asset: AdminAsset | AssetRef) => `${asset.resource_type}/${asset.type}/${asset.public_id}`;

const toRef = (asset: AdminAsset): AssetRef => ({
  resource_type: asset.resource_type,
  type: asset.type,
  public_id: asset.public_id,
});

export function App() {
  const [token, setToken] = useState<string | null>(() => loadStoredToken());
  const [assets, setAssets] = useState<AdminAsset[]>([]);
  const [total, setTotal] = useState(0);

  // The view is seeded from the query string, so a shared or reloaded URL
  // reproduces the same search, sort, page and page size.
  const initial = readViewState(window.location.search);
  const [sort, setSort] = useState<SortKey>(initial.sort);
  const [order, setOrder] = useState<SortOrder>(initial.order);
  const [filter, setFilter] = useState(initial.filter);
  // What's in the box right now, before the debounce promotes it to `filter`.
  const [filterInput, setFilterInput] = useState(initial.filter);
  const [page, setPage] = useState(initial.page);
  const [pageSize, setPageSize] = useState<PageSize>(initial.pageSize);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Explicitly ticked rows, keyed so a selection survives paging. Held as refs
  // rather than whole assets so the set stays small across many pages.
  const [selected, setSelected] = useState<Map<string, AssetRef>>(new Map());
  // "Everything matching the current filter", including rows never rendered.
  // Deliberately separate from `selected`: the server resolves the set from the
  // filter, so the client never has to enumerate ids it has not loaded.
  const [allMatching, setAllMatching] = useState(false);
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);

  const clearSelection = useCallback(() => {
    setSelected(new Map());
    setAllMatching(false);
    setConfirmingBulk(false);
  }, []);

  const signIn = (next: string) => {
    storeToken(next);
    setToken(next);
  };

  const signOut = useCallback(() => {
    setToken((current) => {
      if (current) void logout(current);
      return null;
    });
    storeToken(null);
    setAssets([]);
    clearSelection();
  }, [clearSelection]);

  // Promote the typed value to the active filter once typing pauses. Skipping
  // the no-op case matters on mount: without it, loading `?q=x&page=3` would
  // immediately reset back to page 1.
  useEffect(() => {
    if (filterInput === filter) return;
    const timer = setTimeout(() => {
      setFilter(filterInput);
      setPage(0);
      // The filter defines what "all matching" means, so a selection must not
      // silently carry over to a different result set.
      clearSelection();
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filterInput, filter, clearSelection]);

  // Mirror the view into the address bar. replaceState rather than pushState:
  // the goal is a reproducible URL, not a history entry per keystroke.
  useEffect(() => {
    const search = viewStateToSearch({ page, filter, sort, order, pageSize });
    const next = `${window.location.pathname}${search}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", next);
    }
  }, [page, filter, sort, order, pageSize]);

  // Someone navigating back/forward (or editing the URL) should still land on
  // the view their address bar describes.
  useEffect(() => {
    const onPopState = () => {
      const next = readViewState(window.location.search);
      setSort(next.sort);
      setOrder(next.order);
      setFilter(next.filter);
      setFilterInput(next.filter);
      setPage(next.page);
      setPageSize(next.pageSize);
      clearSelection();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [clearSelection]);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listAssets(token, { sort, order, filter, limit: pageSize, offset: page * pageSize });
      setAssets(result.assets);
      setTotal(result.total);
    } catch (err) {
      // A stale/expired token is the common failure — drop it and show the login form again.
      if (err instanceof ApiError && err.status === 401) signOut();
      else setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [token, sort, order, filter, page, pageSize, signOut]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  // A URL asking for a page past the end (or a page size that shrank the count)
  // lands on the last real page rather than an empty table.
  useEffect(() => {
    if (!loading && total > 0 && page > pages - 1) setPage(pages - 1);
  }, [loading, total, page, pages]);

  const toggleSort = (key: SortKey) => {
    setPage(0);
    if (key === sort) setOrder(order === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      // Names read best A→Z; sizes and dates read best largest/newest first.
      setOrder(key === "name" ? "asc" : "desc");
    }
  };

  const changePageSize = (next: PageSize) => {
    setPageSize(next);
    // Offsets are in rows, so the current page number means something different
    // at the new size — start again from the top.
    setPage(0);
    clearSelection();
  };

  const toggleOne = (asset: AdminAsset, checked: boolean) => {
    // Ticking individual rows is incompatible with "all matching" — narrowing
    // that set row-by-row would silently mean something other than what the
    // banner claims, so fall back to an explicit selection of what is on screen.
    if (allMatching) {
      const explicit = new Map(assets.map((a) => [assetKey(a), toRef(a)] as const));
      if (!checked) explicit.delete(assetKey(asset));
      setAllMatching(false);
      setSelected(explicit);
      return;
    }
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(assetKey(asset), toRef(asset));
      else next.delete(assetKey(asset));
      return next;
    });
    setConfirmingBulk(false);
  };

  const togglePage = (checked: boolean) => {
    setAllMatching(false);
    setConfirmingBulk(false);
    setSelected((current) => {
      const next = new Map(current);
      for (const asset of assets) {
        if (checked) next.set(assetKey(asset), toRef(asset));
        else next.delete(assetKey(asset));
      }
      return next;
    });
  };

  const remove = async (asset: AdminAsset) => {
    if (!token) return;
    const key = assetKey(asset);
    setPendingDelete(key);
    setError(null);
    try {
      await deleteAsset(token, asset);
      setSelected((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      else setError(String(err));
    } finally {
      setPendingDelete(null);
    }
  };

  const deleteSelected = async () => {
    if (!token) return;
    setConfirmingBulk(false);
    setBulkBusy(true);
    setError(null);
    try {
      if (allMatching) {
        // The server deletes a bounded batch per call and reports what is left,
        // so a set spanning many pages drains in a loop with visible progress.
        let done = 0;
        for (;;) {
          const result = await bulkDeleteMatching(token, filter);
          done += result.deleted;
          setBulkProgress(`Deleted ${done}…`);
          if (result.remaining === 0 || result.deleted === 0) break;
        }
      } else {
        const refs = [...selected.values()];
        let done = 0;
        for (let i = 0; i < refs.length; i += BULK_DELETE_BATCH) {
          const result = await bulkDeleteAssets(token, refs.slice(i, i + BULK_DELETE_BATCH));
          done += result.deleted;
          setBulkProgress(`Deleted ${done} of ${refs.length}…`);
        }
      }
      clearSelection();
      setPage(0);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      else setError(String(err));
    } finally {
      setBulkBusy(false);
      setBulkProgress(null);
    }
  };

  if (!token) return <Login onToken={signIn} />;

  const selectionCount = allMatching ? total : selected.size;
  const allOnPageSelected = assets.length > 0 && assets.every((asset) => selected.has(assetKey(asset)));
  // Offer the cross-page escalation only once the whole page is ticked and there
  // is genuinely more beyond it.
  const canEscalate = allOnPageSelected && !allMatching && total > assets.length;

  return (
    <div className="app">
      <header>
        <h1>Assets</h1>
        <div className="header-actions">
          <input
            type="search"
            placeholder="Filter by name or tag…"
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
          />
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {selectionCount > 0 ? (
        <div className="selection-bar">
          <span className="count">
            {selectionCount.toLocaleString()} selected
            {allMatching ? " (all matching results)" : ""}
          </span>

          {confirmingBulk ? (
            <>
              <button type="button" className="danger" onClick={() => void deleteSelected()} disabled={bulkBusy}>
                {bulkBusy ? (bulkProgress ?? "Deleting…") : `Permanently delete ${selectionCount.toLocaleString()}`}
              </button>
              <button type="button" onClick={() => setConfirmingBulk(false)} disabled={bulkBusy}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmingBulk(true)} disabled={bulkBusy}>
              {bulkBusy ? (bulkProgress ?? "Deleting…") : "Delete selected"}
            </button>
          )}

          <button type="button" className="link" onClick={clearSelection} disabled={bulkBusy}>
            Clear selection
          </button>

          {canEscalate ? (
            <span className="escalate">
              All {assets.length} on this page are selected.{" "}
              <button type="button" className="link" onClick={() => setAllMatching(true)}>
                Select all {total.toLocaleString()} matching {filter.trim() === "" ? "assets" : `“${filter.trim()}”`}
              </button>
            </span>
          ) : null}

          {allMatching ? (
            <span className="escalate warn">
              Deleting will remove every asset matching {filter.trim() === "" ? "the store" : `“${filter.trim()}”`},
              including rows on other pages.
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <AssetTable
        assets={assets}
        sort={sort}
        order={order}
        onSort={toggleSort}
        onDelete={(asset) => void remove(asset)}
        pendingDelete={pendingDelete}
        selected={allMatching ? new Set(assets.map(assetKey)) : new Set(selected.keys())}
        onToggleOne={toggleOne}
        onTogglePage={togglePage}
      />

      <footer>
        <span className="muted">
          {total.toLocaleString()} asset{total === 1 ? "" : "s"} · page {page + 1} of {pages.toLocaleString()}
        </span>
        <span className="page-size">
          <label htmlFor="page-size">Rows per page</label>{" "}
          <select
            id="page-size"
            value={pageSize}
            onChange={(e) => changePageSize(Number(e.target.value) as PageSize)}
            disabled={loading || bulkBusy}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size.toLocaleString()}
              </option>
            ))}
          </select>
        </span>
        <span className="pager">
          <button type="button" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>
            Previous
          </button>
          <button type="button" onClick={() => setPage(page + 1)} disabled={page + 1 >= pages}>
            Next
          </button>
        </span>
      </footer>
    </div>
  );
}
