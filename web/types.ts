/**
 * Types shared by the browser modules, kept free of any DOM reference so they
 * can also be imported from Bun-side tests, which typecheck without `lib.dom`.
 */

export type SortKey = "name" | "size" | "date";
export type SortOrder = "asc" | "desc";
