import { describe, expect, it } from "vitest";
import {
  ariaSortFor,
  clampPage,
  countLabel,
  headerCheckState,
  matchesQuery,
  nextSorting,
  pageCount,
  pageItems,
  pageRange,
  parseSortOptionValue,
  pruneSelection,
  rangeLabel,
  sliceForPage,
  sortOptionValue,
  sortSelectOptions,
  toggleAllVisible,
  toggleId,
} from "@/components/data-table/model";

describe("sorting", () => {
  it("flips the sorted column and starts a new column ascending (licenses)", () => {
    expect(nextSorting([{ id: "expiry", desc: false }], "expiry")).toEqual([{ id: "expiry", desc: true }]);
    expect(nextSorting([{ id: "expiry", desc: true }], "expiry")).toEqual([{ id: "expiry", desc: false }]);
    expect(nextSorting([{ id: "expiry", desc: true }], "status")).toEqual([{ id: "status", desc: false }]);
    expect(nextSorting([], "status")).toEqual([{ id: "status", desc: false }]);
  });

  it("starts a new column descending when asked (orders, amounts)", () => {
    expect(nextSorting([{ id: "date", desc: true }], "total", true)).toEqual([{ id: "total", desc: true }]);
  });

  it("puts aria-sort on the sorted column only", () => {
    const sorting = [{ id: "date", desc: true }];
    expect(ariaSortFor(sorting, "date")).toBe("descending");
    expect(ariaSortFor([{ id: "date", desc: false }], "date")).toBe("ascending");
    expect(ariaSortFor(sorting, "total")).toBeUndefined();
    expect(ariaSortFor([], "total")).toBeUndefined();
  });
});

describe("selection", () => {
  it("derives the header checkbox state from the visible rows", () => {
    const visible = ["a", "b", "c"];
    expect(headerCheckState(new Set(), visible)).toBe(false);
    expect(headerCheckState(new Set(["a"]), visible)).toBe("indeterminate");
    expect(headerCheckState(new Set(["a", "b", "c", "z"]), visible)).toBe(true);
    expect(headerCheckState(new Set(["z"]), visible)).toBe(false);
    expect(headerCheckState(new Set(["a"]), [])).toBe(false);
  });

  it("toggles one id", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });

  it("select-all adds the missing visible rows and keeps other pages", () => {
    expect(toggleAllVisible(["x", "a"], ["a", "b", "c"])).toEqual(["x", "a", "b", "c"]);
  });

  it("select-all removes the visible rows when they are all selected", () => {
    expect(toggleAllVisible(["x", "a", "b", "c"], ["a", "b", "c"])).toEqual(["x"]);
    expect(toggleAllVisible(["x"], [])).toEqual(["x"]);
  });

  it("prunes ids that left the data, returning the same array when nothing changed", () => {
    const selected = ["a", "b"];
    expect(pruneSelection(selected, ["a", "b", "c"])).toBe(selected);
    expect(pruneSelection(selected, new Set(["b"]))).toEqual(["b"]);
  });
});

describe("paging", () => {
  it("counts pages (at least one)", () => {
    expect(pageCount(0, 8)).toBe(1);
    expect(pageCount(8, 8)).toBe(1);
    expect(pageCount(9, 8)).toBe(2);
    expect(pageCount(23, 8)).toBe(3);
    expect(pageCount(10, 0)).toBe(1);
  });

  it("clamps the page into range", () => {
    expect(clampPage(5, 23, 8)).toBe(3);
    expect(clampPage(0, 23, 8)).toBe(1);
    expect(clampPage(Number.NaN, 23, 8)).toBe(1);
    expect(clampPage(2.7, 23, 8)).toBe(2);
  });

  it("computes the visible range and footer text", () => {
    expect(pageRange(1, 8, 23)).toEqual({ from: 1, to: 8, total: 23 });
    expect(pageRange(3, 8, 23)).toEqual({ from: 17, to: 23, total: 23 });
    expect(pageRange(9, 8, 23)).toEqual({ from: 17, to: 23, total: 23 });
    expect(pageRange(1, 8, 0)).toEqual({ from: 0, to: 0, total: 0 });
    expect(rangeLabel(1, 8, 3)).toBe("Showing 1\u20133 of 3");
    expect(rangeLabel(1, 8, 0, "0 orders")).toBe("0 orders");
  });

  it("slices a page of rows", () => {
    const rows = Array.from({ length: 23 }, (_, i) => i + 1);
    expect(sliceForPage(rows, 1, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sliceForPage(rows, 3, 8)).toEqual([17, 18, 19, 20, 21, 22, 23]);
    expect(sliceForPage(rows, 99, 8)).toEqual([17, 18, 19, 20, 21, 22, 23]);
    expect(sliceForPage([], 1, 8)).toEqual([]);
  });

  it("lists numbered pages with gaps and a stable number of slots", () => {
    expect(pageItems(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageItems(1, 10)).toEqual([1, 2, 3, 4, 5, "gap", 10]);
    expect(pageItems(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
    expect(pageItems(10, 10)).toEqual([1, "gap", 6, 7, 8, 9, 10]);
    expect(pageItems(4, 10)).toEqual([1, 2, 3, 4, 5, "gap", 10]);
    expect(pageItems(7, 10)).toEqual([1, "gap", 6, 7, 8, 9, 10]);
    for (let page = 1; page <= 40; page += 1) expect(pageItems(page, 40)).toHaveLength(7);
    expect(pageItems(3, 0)).toEqual([1]);
  });
});

describe("search and labels", () => {
  const fields = ["LIC-24017", "Medical Store Billing", "K8NM", null, undefined, 3];

  it("matches every term case-insensitively across fields", () => {
    expect(matchesQuery("", fields)).toBe(true);
    expect(matchesQuery("  ", fields)).toBe(true);
    expect(matchesQuery("lic-240", fields)).toBe(true);
    expect(matchesQuery("medical k8nm", fields)).toBe(true);
    expect(matchesQuery("medical cheque", fields)).toBe(false);
  });

  it("does not match across field boundaries", () => {
    expect(matchesQuery("k8nm3", fields)).toBe(false);
  });

  it("pluralises counts with Indian digit grouping", () => {
    expect(countLabel(1)).toBe("1 result");
    expect(countLabel(67)).toBe("67 results");
    expect(countLabel(125000, "device")).toBe("1,25,000 devices");
  });
});

describe("phone sort select (cards have no sortable headers)", () => {
  const orderColumns = [
    { id: "date", label: "Date", descFirst: true, labels: { asc: "oldest first", desc: "newest first" } },
    { id: "status", label: "Status", descFirst: true },
    { id: "total", label: "Total", descFirst: true, numeric: true },
  ];

  it("lists every sortable column both ways, the header's first-click direction first", () => {
    const { options, value } = sortSelectOptions(orderColumns, [{ id: "date", desc: true }]);
    expect(options).toEqual([
      { value: "date:desc", label: "Date: newest first" },
      { value: "date:asc", label: "Date: oldest first" },
      { value: "status:desc", label: "Status: descending" },
      { value: "status:asc", label: "Status: ascending" },
      { value: "total:desc", label: "Total: highest first" },
      { value: "total:asc", label: "Total: lowest first" },
    ]);
    expect(value).toBe("date:desc");
  });

  it("leads with Default order while nothing (or an unlisted column) is sorted", () => {
    const columns = [{ id: "product", label: "License", descFirst: false, labels: { asc: "A to Z", desc: "Z to A" } }];
    expect(sortSelectOptions(columns, [])).toEqual({
      options: [
        { value: "", label: "Default order" },
        { value: "product:asc", label: "License: A to Z" },
        { value: "product:desc", label: "License: Z to A" },
      ],
      value: "",
    });
    expect(sortSelectOptions(columns, [{ id: "key", desc: false }]).options[0]).toEqual({ value: "key:asc", label: "Default order" });
    expect(sortSelectOptions([], [])).toEqual({ options: [], value: "" });
  });

  it("round-trips option values to the sorting the header buttons set", () => {
    expect(sortOptionValue({ id: "total", desc: true })).toBe("total:desc");
    expect(parseSortOptionValue("total:desc")).toEqual({ id: "total", desc: true });
    expect(parseSortOptionValue("a:b:asc")).toEqual({ id: "a:b", desc: false });
    expect(parseSortOptionValue("")).toBeNull();
    expect(parseSortOptionValue("total")).toBeNull();
    expect(parseSortOptionValue(":asc")).toBeNull();
    expect(parseSortOptionValue("total:up")).toBeNull();
  });
});
