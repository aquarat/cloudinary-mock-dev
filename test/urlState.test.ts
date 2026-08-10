import { describe, expect, test } from "bun:test";
import { DEFAULT_VIEW_STATE, PAGE_SIZES, readViewState, viewStateToSearch, type ViewState } from "../web/urlState";

describe("admin view state in the query string", () => {
  test("an empty query string yields the defaults", () => {
    expect(readViewState("")).toEqual(DEFAULT_VIEW_STATE);
  });

  test("reads every parameter, translating page from 1-based to 0-based", () => {
    expect(readViewState("?q=apple&sort=size&order=asc&per=250&page=3")).toEqual({
      page: 2,
      filter: "apple",
      sort: "size",
      order: "asc",
      pageSize: 250,
    });
  });

  test("rejects values outside the allowed sets rather than passing them through", () => {
    const state = readViewState("?sort=drop-table&order=sideways&per=7&page=0");
    expect(state.sort).toBe("date");
    expect(state.order).toBe("desc");
    // 7 is not an offered page size, so it falls back rather than reaching the server.
    expect(state.pageSize).toBe(50);
    expect(state.page).toBe(0);
  });

  test("a negative or non-numeric page is page one", () => {
    expect(readViewState("?page=-5").page).toBe(0);
    expect(readViewState("?page=abc").page).toBe(0);
  });

  test("serialising omits defaults so an untouched view has a clean URL", () => {
    expect(viewStateToSearch(DEFAULT_VIEW_STATE)).toBe("");
  });

  test("serialising emits only what differs from the defaults", () => {
    const state: ViewState = { page: 4, filter: "cats", sort: "name", order: "asc", pageSize: 1000 };
    const params = new URLSearchParams(viewStateToSearch(state).slice(1));
    expect(params.get("q")).toBe("cats");
    expect(params.get("sort")).toBe("name");
    expect(params.get("order")).toBe("asc");
    expect(params.get("per")).toBe("1000");
    expect(params.get("page")).toBe("5");
  });

  test("a round trip preserves every offered page size", () => {
    for (const pageSize of PAGE_SIZES) {
      const state: ViewState = { ...DEFAULT_VIEW_STATE, pageSize };
      expect(readViewState(viewStateToSearch(state))).toEqual(state);
    }
  });

  test("round trips a fully populated state", () => {
    const state: ViewState = { page: 9, filter: "a b", sort: "size", order: "asc", pageSize: 2500 };
    expect(readViewState(viewStateToSearch(state))).toEqual(state);
  });
});
