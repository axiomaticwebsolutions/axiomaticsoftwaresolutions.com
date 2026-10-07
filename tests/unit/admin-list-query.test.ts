import { describe, expect, it } from "vitest";
import {
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
  pageResult,
  parseListQuery,
  searchWhere,
  toPrismaOrderBy,
} from "@/lib/admin/list-query";

const ORDERS = {
  filters: {
    status: ["paid", "pending", "refunded"] as const,
    product: (raw: string) => (/^[a-z0-9-]{1,40}$/.test(raw) ? raw : undefined),
    minTotal: (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : null),
  },
  sortable: ["createdAt", "total", "customer"] as const,
  defaultSort: "-createdAt" as const,
};

const url = (query: string) => `https://axiomatic.test/api/admin/orders${query ? `?${query}` : ""}`;

describe("parseListQuery", () => {
  it("returns the defaults for an empty query", () => {
    expect(parseListQuery(url(""), ORDERS)).toEqual({
      q: "",
      filters: {},
      sort: { id: "createdAt", desc: true },
      page: 1,
      pageSize: ADMIN_DEFAULT_PAGE_SIZE,
      skip: 0,
      take: 25,
    });
  });

  it("reads q, filter[x], sort, page and pageSize (api-contracts section 7)", () => {
    const query = parseListQuery(
      url("q=%20%20Sharma%20%20Medicals%20&filter[status]=paid&filter[product]=gst-billing&filter[minTotal]=500&sort=total&page=3&pageSize=50"),
      ORDERS,
    );
    expect(query).toEqual({
      q: "Sharma Medicals",
      filters: { status: "paid", product: "gst-billing", minTotal: 500 },
      sort: { id: "total", desc: false },
      page: 3,
      pageSize: 50,
      skip: 100,
      take: 50,
    });
  });

  it("accepts a Request, URL, URLSearchParams, a path or a bare query string", () => {
    const expected = { status: "pending" };
    expect(parseListQuery(new Request(url("filter[status]=pending")), ORDERS).filters).toEqual(expected);
    expect(parseListQuery(new URL(url("filter[status]=pending")), ORDERS).filters).toEqual(expected);
    expect(parseListQuery(new URLSearchParams("filter[status]=pending"), ORDERS).filters).toEqual(expected);
    expect(parseListQuery("/api/admin/orders?filter[status]=pending", ORDERS).filters).toEqual(expected);
    expect(parseListQuery("filter[status]=pending", ORDERS).filters).toEqual(expected);
    expect(parseListQuery("/api/admin/orders", ORDERS).filters).toEqual({});
  });

  it("ignores unknown or invalid filter values, 'all' and plain (non-bracket) filters", () => {
    const query = parseListQuery(url("filter[status]=shipped&filter[product]=BAD!&filter[minTotal]=x&filter[other]=1&status=paid"), ORDERS);
    expect(query.filters).toEqual({});
    expect(parseListQuery(url("filter[status]=all"), ORDERS).filters).toEqual({});
    expect(parseListQuery(url(`filter[product]=${"a".repeat(300)}`), ORDERS).filters).toEqual({});
  });

  it("falls back to the default sort for unknown or malformed columns", () => {
    expect(parseListQuery(url("sort=-customer"), ORDERS).sort).toEqual({ id: "customer", desc: true });
    expect(parseListQuery(url("sort=passwordHash"), ORDERS).sort).toEqual({ id: "createdAt", desc: true });
    expect(parseListQuery(url("sort=--total"), ORDERS).sort).toEqual({ id: "createdAt", desc: true });
    expect(parseListQuery(url(""), { ...ORDERS, defaultSort: { id: "customer", desc: false } }).sort).toEqual({ id: "customer", desc: false });
    expect(() => parseListQuery(url(""), { ...ORDERS, defaultSort: "--x" as never })).toThrow(RangeError);
  });

  it("caps pageSize at 100 and falls back for invalid pages and sizes", () => {
    expect(parseListQuery(url("pageSize=500"), ORDERS).pageSize).toBe(ADMIN_MAX_PAGE_SIZE);
    expect(parseListQuery(url("pageSize=0"), ORDERS).pageSize).toBe(25);
    expect(parseListQuery(url("pageSize=-5"), ORDERS).pageSize).toBe(25);
    expect(parseListQuery(url("pageSize=10.5"), ORDERS).pageSize).toBe(25);
    expect(parseListQuery(url("pageSize=99999999"), ORDERS).pageSize).toBe(25);
    expect(parseListQuery(url(""), { ...ORDERS, defaultPageSize: 10 }).pageSize).toBe(10);
    expect(parseListQuery(url(""), { ...ORDERS, defaultPageSize: 1000 }).pageSize).toBe(100);
    expect(parseListQuery(url("page=0"), ORDERS).page).toBe(1);
    expect(parseListQuery(url("page=abc"), ORDERS).page).toBe(1);
    expect(parseListQuery(url("page=9999999"), ORDERS).page).toBe(1);
  });

  it("can turn search off and caps its length", () => {
    expect(parseListQuery(url("q=hello"), { ...ORDERS, searchable: false }).q).toBe("");
    expect(parseListQuery(url(`q=${"x".repeat(150)}`), ORDERS).q).toHaveLength(100);
    expect(parseListQuery(url(`q=${"x".repeat(50)}`), { ...ORDERS, maxQueryLength: 20 }).q).toHaveLength(20);
  });
});

describe("toPrismaOrderBy", () => {
  it("orders by the column then id in the same direction", () => {
    expect(toPrismaOrderBy({ id: "createdAt", desc: true })).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(toPrismaOrderBy({ id: "id", desc: false })).toEqual([{ id: "asc" }]);
  });

  it("maps columns to relation paths, nulls positions and custom orderings", () => {
    const columns = {
      customer: "account.legalName",
      expires: { path: "expiresAt", nulls: "last" as const },
      devices: (dir: "asc" | "desc") => ({ devices: { _count: dir } }),
    };
    expect(toPrismaOrderBy({ id: "customer", desc: false }, columns)).toEqual([{ account: { legalName: "asc" } }, { id: "asc" }]);
    expect(toPrismaOrderBy({ id: "expires", desc: true }, columns)).toEqual([{ expiresAt: { sort: "desc", nulls: "last" } }, { id: "desc" }]);
    expect(toPrismaOrderBy({ id: "devices", desc: true }, columns)).toEqual([{ devices: { _count: "desc" } }, { id: "desc" }]);
  });

  it("takes another tie-breaker or none", () => {
    expect(toPrismaOrderBy({ id: "name", desc: false }, {}, { tiebreak: "code" })).toEqual([{ name: "asc" }, { code: "asc" }]);
    expect(toPrismaOrderBy({ id: "name", desc: false }, {}, { tiebreak: null })).toEqual([{ name: "asc" }]);
  });

  it("does not read inherited keys as columns", () => {
    const expected: Record<string, unknown>[] = [{ constructor: "asc" }, { id: "asc" }];
    expect(toPrismaOrderBy({ id: "constructor", desc: false })).toEqual(expected);
  });
});

describe("searchWhere", () => {
  it("is undefined without a search", () => {
    expect(searchWhere("", ["id"])).toBeUndefined();
    expect(searchWhere("   ", ["id"])).toBeUndefined();
    expect(searchWhere("x", [])).toBeUndefined();
  });

  it("ORs case-insensitive matches over field paths", () => {
    expect(searchWhere(" sharma ", ["email", "account.legalName", { path: "id", match: "startsWith" }, { path: "code", match: "equals", caseSensitive: true }])).toEqual({
      OR: [
        { email: { contains: "sharma", mode: "insensitive" } },
        { account: { legalName: { contains: "sharma", mode: "insensitive" } } },
        { id: { startsWith: "sharma", mode: "insensitive" } },
        { code: { equals: "sharma" } },
      ],
    });
  });
});

describe("pageResult", () => {
  it("wraps items in the list envelope", () => {
    expect(pageResult([{ id: 1 }], 41, { page: 2, pageSize: 25 })).toEqual({ items: [{ id: 1 }], total: 41, page: 2, pageSize: 25 });
  });
});
