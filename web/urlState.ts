/**
 * The table's view state lives in the query string so a particular view — a
 * search, a sort, a page — is a shareable, reloadable URL rather than something
 * that only exists in component state.
 *
 * Values are validated on the way in: a hand-edited or stale URL degrades to the
 * defaults instead of putting the table into a state the server would reject.
 */

import type { SortKey, SortOrder } from "./types";

export const PAGE_SIZES = [50, 100, 250, 500, 1000, 2500, 5000] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 50;
const DEFAULT_SORT: SortKey = "date";
const DEFAULT_ORDER: SortOrder = "desc";

export interface ViewState {
  /** Zero-based internally; exposed in the URL as a friendlier 1-based `page`. */
  page: number;
  filter: string;
  sort: SortKey;
  order: SortOrder;
  pageSize: PageSize;
}

export const DEFAULT_VIEW_STATE: ViewState = {
  page: 0,
  filter: "",
  sort: DEFAULT_SORT,
  order: DEFAULT_ORDER,
  pageSize: DEFAULT_PAGE_SIZE,
};

function isSortKey(value: string | null): value is SortKey {
  return value === "name" || value === "size" || value === "date";
}

function isSortOrder(value: string | null): value is SortOrder {
  return value === "asc" || value === "desc";
}

function toPageSize(value: string | null): PageSize {
  const parsed = Number(value);
  return (PAGE_SIZES as readonly number[]).includes(parsed) ? (parsed as PageSize) : DEFAULT_PAGE_SIZE;
}

export function readViewState(search: string): ViewState {
  const params = new URLSearchParams(search);

  const rawPage = Number(params.get("page"));
  // `page` is 1-based in the URL; anything unparseable or below 1 is page one.
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) - 1 : 0;

  const sort = params.get("sort");
  const order = params.get("order");

  return {
    page,
    filter: params.get("q") ?? "",
    sort: isSortKey(sort) ? sort : DEFAULT_SORT,
    order: isSortOrder(order) ? order : DEFAULT_ORDER,
    pageSize: toPageSize(params.get("per")),
  };
}

/** Serialises to a query string, omitting defaults so an untouched view stays a clean `/admin`. */
export function viewStateToSearch(state: ViewState): string {
  const params = new URLSearchParams();
  if (state.filter.trim() !== "") params.set("q", state.filter.trim());
  if (state.sort !== DEFAULT_SORT) params.set("sort", state.sort);
  if (state.order !== DEFAULT_ORDER) params.set("order", state.order);
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set("per", String(state.pageSize));
  if (state.page > 0) params.set("page", String(state.page + 1));
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}
