import { describe, expect, it } from "vitest";
import {
  clearListFilters,
  defaultListState,
  defineListState,
  formatSort,
  fromSortingState,
  isListFiltered,
  listStateHref,
  listStateToParams,
  normalizeQuery,
  pageWindow,
  parseListState,
  parsePage,
  parseSort,
  readParam,
  sameListState,
  toSortingState,
  updateListState,
} from "@/lib/url-state";

const ORDERS = defineListState({
  filters: { status: { values: ["paid", "refunded", "pending", "failed", "canceled"] } },
  sortable: ["date", "status", "total"],
  defaultSort: { id: "date", desc: true },
  pageSize: 8,
});

const DEVICES = defineListState({
  filters: { status: { values: ["inactive", "deactivated", "all"], default: "active" }, location: {} },
  pageSize: 25,
  pageSizes: [25, 50, 100],
});

const ADMIN = defineListState({
  filters: { status: { values: ["paid", "failed"] } },
  filterStyle: "bracket",
  defaultSort: { id: "createdAt", desc: true },
  pageSize: 25,
});

describe("parseSort / formatSort / parsePage", () => {
  it("round-trips ascending and descending sorts", () => {
    expect(parseSort("-date")).toEqual({ id: "date", desc: true });
    expect(parseSort("expiry")).toEqual({ id: "expiry", desc: false });
    expect(formatSort({ id: "date", desc: true })).toBe("-date");
    expect(formatSort({ id: "total", desc: false })).toBe("total");
  });

  it("rejects malformed sorts", () => {
    for (const raw of ["", "-", "--date", "1abc", "da te", "a;drop", null, undefined]) expect(parseSort(raw)).toBeNull();
  });

  it("accepts positive page numbers only", () => {
    expect(parsePage("3")).toBe(3);
    for (const raw of ["0", "-1", "1.5", "abc", "", "9999999", null]) expect(parsePage(raw)).toBe(1);
  });

  it("normalises queries", () => {
    expect(normalizeQuery("  AX-10   288 ")).toBe("AX-10 288");
    expect(normalizeQuery("x".repeat(150))).toHaveLength(100);
    expect(normalizeQuery(null)).toBe("");
  });
});

describe("parseListState", () => {
  it("returns defaults for empty params", () => {
    expect(parseListState(new URLSearchParams(), ORDERS)).toEqual({
      q: "",
      filters: { status: "all" },
      sort: { id: "date", desc: true },
      page: 1,
      pageSize: 8,
    });
  });

  it("reads URLSearchParams and Next.js searchParams objects alike", () => {
    const fromParams = parseListState(new URLSearchParams("q=AX-10&status=paid&sort=total&page=2"), ORDERS);
    const fromRecord = parseListState({ q: "AX-10", status: ["paid", "refunded"], sort: "total", page: "2" }, ORDERS);
    expect(fromParams).toEqual({ q: "AX-10", filters: { status: "paid" }, sort: { id: "total", desc: false }, page: 2, pageSize: 8 });
    expect(fromRecord).toEqual(fromParams);
  });

  it("falls back to defaults for unknown filter values, sort columns and page sizes", () => {
    const state = parseListState(new URLSearchParams("status=hacked&sort=-secret&page=x&pageSize=500"), ORDERS);
    expect(state.filters.status).toBe("all");
    expect(state.sort).toEqual({ id: "date", desc: true });
    expect(state.page).toBe(1);
    expect(state.pageSize).toBe(8);
  });

  it("accepts id-like values for filters without a value list, and allowed page sizes", () => {
    const state = parseListState(new URLSearchParams("location=cm1loc2abc&pageSize=50&status=all"), DEVICES);
    expect(state.filters).toEqual({ status: "all", location: "cm1loc2abc" });
    expect(state.pageSize).toBe(50);
    expect(parseListState(new URLSearchParams("location=<script>"), DEVICES).filters.location).toBe("all");
  });

  it("uses a custom filter default", () => {
    expect(defaultListState(DEVICES).filters.status).toBe("active");
  });

  it("reads bracket-style filters for the admin contract", () => {
    const state = parseListState(new URLSearchParams("filter[status]=paid&status=failed"), ADMIN);
    expect(state.filters.status).toBe("paid");
  });
});

describe("listStateToParams / listStateHref", () => {
  it("leaves defaults out of the URL", () => {
    expect(listStateHref("/account/orders", defaultListState(ORDERS), ORDERS)).toBe("/account/orders");
  });

  it("writes non-default values and keeps unrelated params", () => {
    const state = { ...defaultListState(ORDERS), q: " AX-10 ", filters: { status: "paid" }, sort: { id: "total", desc: false }, page: 3 };
    const params = listStateToParams(state, ORDERS, "tab=devices&page=9");
    expect(params.get("tab")).toBe("devices");
    expect(params.get("q")).toBe("AX-10");
    expect(params.get("status")).toBe("paid");
    expect(params.get("sort")).toBe("total");
    expect(params.get("page")).toBe("3");
  });

  it("removes params that went back to their defaults", () => {
    const params = listStateToParams(defaultListState(ORDERS), ORDERS, "q=old&status=paid&sort=total&page=4");
    expect(params.toString()).toBe("");
  });

  it("round-trips through the parser", () => {
    const state = {
      q: "kiosk",
      filters: { status: "deactivated", location: "loc_1" },
      sort: { id: "lastSeen", desc: true },
      page: 2,
      pageSize: 100,
    };
    const href = listStateHref("/account/devices", state, DEVICES);
    expect(parseListState(new URL(href, "http://x").searchParams, DEVICES)).toEqual(state);
  });

  it("writes bracket filters", () => {
    const state = { ...defaultListState(ADMIN), filters: { status: "failed" } };
    expect(listStateHref("/admin/orders", state, ADMIN)).toBe("/admin/orders?filter%5Bstatus%5D=failed");
  });

  it("supports custom parameter names", () => {
    const config = defineListState({ params: { q: "aq", page: "apage" } });
    const href = listStateHref("/dev/ui", { ...defaultListState(config), q: "x", page: 2 }, config);
    expect(href).toBe("/dev/ui?aq=x&apage=2");
    expect(readParam(new URL(href, "http://x").searchParams, "aq")).toBe("x");
  });
});

describe("updateListState", () => {
  const base = { ...defaultListState(ORDERS), page: 4 };

  it("goes back to page 1 when the search, a filter, the sort or the page size changes", () => {
    expect(updateListState(base, { q: "AX" }).page).toBe(1);
    expect(updateListState(base, { filters: { status: "paid" } }).page).toBe(1);
    expect(updateListState(base, { sort: { id: "total", desc: true } }).page).toBe(1);
    expect(updateListState(base, { pageSize: 16 }).page).toBe(1);
  });

  it("keeps the page for no-op changes and explicit pages", () => {
    expect(updateListState(base, { q: "" }).page).toBe(4);
    expect(updateListState(base, { q: "  " }).page).toBe(4);
    expect(updateListState(base, { filters: { status: "all" } }).page).toBe(4);
    expect(updateListState(base, { sort: { id: "date", desc: true } }).page).toBe(4);
    expect(updateListState(base, { page: 2 }).page).toBe(2);
    expect(updateListState(base, { q: "AX", page: 3 }).page).toBe(3);
  });

  it("merges filter patches", () => {
    const devices = defaultListState(DEVICES);
    expect(updateListState(devices, { filters: { location: "loc_1" } }).filters).toEqual({ status: "active", location: "loc_1" });
  });
});

describe("filters, equality and sorting helpers", () => {
  it("detects and clears active filters (sort and page size kept)", () => {
    const state = { ...defaultListState(ORDERS), q: "AX", filters: { status: "paid" }, sort: { id: "total", desc: false }, page: 3 };
    expect(isListFiltered(state, ORDERS)).toBe(true);
    expect(isListFiltered({ ...defaultListState(ORDERS), page: 5 }, ORDERS)).toBe(false);
    expect(clearListFilters(state, ORDERS)).toEqual({
      q: "",
      filters: { status: "all" },
      sort: { id: "total", desc: false },
      page: 1,
      pageSize: 8,
    });
  });

  it("compares states with normalised queries", () => {
    const a = defaultListState(ORDERS);
    expect(sameListState(a, { ...a, q: "  " })).toBe(true);
    expect(sameListState(a, { ...a, sort: { id: "date", desc: false } })).toBe(false);
    expect(sameListState(a, { ...a, filters: { status: "paid" } })).toBe(false);
  });

  it("converts to and from TanStack sorting", () => {
    expect(toSortingState({ id: "date", desc: true })).toEqual([{ id: "date", desc: true }]);
    expect(toSortingState(null)).toEqual([]);
    expect(fromSortingState([{ id: "total", desc: false }, { id: "date", desc: true }])).toEqual({ id: "total", desc: false });
    expect(fromSortingState([])).toBeNull();
  });

  it("computes skip/take windows", () => {
    expect(pageWindow(1, 10)).toEqual({ skip: 0, take: 10 });
    expect(pageWindow(3, 8)).toEqual({ skip: 16, take: 8 });
    expect(pageWindow(0, 0)).toEqual({ skip: 0, take: 1 });
  });
});
