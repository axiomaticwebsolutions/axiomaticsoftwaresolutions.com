import { describe, expect, it } from "vitest";
import {
  exportResult,
  exportToastMessage,
  ORDER_STATUS_OPTIONS,
  orderDateLabel,
  orderInvoiceLabel,
  orderListQuery,
  orderRowAction,
  ORDERS_EXPORT_PATH,
  ORDERS_LIST,
  ordersDescription,
  ordersExportHref,
  orderTaxLabel,
  orderTotalLabel,
} from "@/components/account/orders/orders-model";
import { parseListState } from "@/lib/url-state";
import { parseOrderListQuery } from "@/lib/validation/portal";

const parse = (query: string) => parseListState(new URLSearchParams(query), ORDERS_LIST);

describe("Orders list state (URL)", () => {
  it("defaults to all statuses, newest first, page 1, 8 per page", () => {
    const state = parse("");
    expect(state).toEqual({ q: "", filters: { status: "all" }, sort: { id: "date", desc: true }, page: 1, pageSize: 8 });
    expect(orderListQuery(state)).toEqual({ q: "", status: "all", sort: { key: "date", dir: -1 }, page: 1 });
  });

  it("reads search, status, sort and page", () => {
    const state = parse("q=AX-10&status=refunded&sort=total&page=2");
    expect(orderListQuery(state)).toEqual({ q: "AX-10", status: "refunded", sort: { key: "total", dir: 1 }, page: 2 });
    expect(orderListQuery(parse("sort=-status")).sort).toEqual({ key: "status", dir: -1 });
  });

  it("falls back to defaults for invalid values instead of failing", () => {
    const state = parse("status=bogus&sort=-invoice&page=0&q=%20%20");
    expect(orderListQuery(state)).toEqual({ q: "", status: "all", sort: { key: "date", dir: -1 }, page: 1 });
  });

  it("produces the same query the API route parses", () => {
    for (const query of ["", "q=AXS%2F26&status=pending&sort=-total&page=3", "status=canceled&sort=date"]) {
      expect(orderListQuery(parse(query))).toEqual(parseOrderListQuery(new URLSearchParams(query)));
    }
  });

  it("offers the prototype's status options in order", () => {
    expect(ORDER_STATUS_OPTIONS.map((o) => o.label)).toEqual(["All", "Paid", "Refunded", "Pending", "Failed", "Canceled"]);
  });
});

describe("accountant export URL", () => {
  it("is the bare path for the default view", () => {
    expect(ordersExportHref(parse(""))).toBe(ORDERS_EXPORT_PATH);
  });

  it("carries search, status and sort but never the page", () => {
    const href = ordersExportHref(parse("q=AX-1&status=paid&sort=-total&page=4"));
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe(ORDERS_EXPORT_PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "AX-1", status: "paid", sort: "-total" });
  });
});

describe("row labels", () => {
  const row = {
    id: "AX-10288",
    createdAt: "2026-09-16T20:00:00.000Z",
    invoiceNumber: "AXS/26-27/1174",
    invoicePdfHref: "/api/orders/AX-10288/invoice.pdf",
    totalPaise: 412882,
    taxPaise: 62982,
  };

  it("formats dates in IST and amounts with paise", () => {
    expect(orderDateLabel(row)).toBe("17 Sep 2026");
    expect(orderTotalLabel(row)).toBe("₹4,128.82");
    expect(orderTotalLabel({ totalPaise: 589800 })).toBe("₹5,898.00");
    expect(orderTaxLabel(row)).toBe("incl. ₹629.82 GST");
    expect(orderInvoiceLabel(row)).toBe("AXS/26-27/1174");
    expect(orderInvoiceLabel({ invoiceNumber: null })).toBe("—");
  });

  it("downloads the invoice once there is one, else links to the order page", () => {
    expect(orderRowAction(row)).toEqual({
      kind: "invoice",
      label: "Invoice",
      icon: "description",
      href: "/api/orders/AX-10288/invoice.pdf",
      ariaLabel: "Download invoice AXS/26-27/1174",
      fileName: "Invoice-AXS-26-27-1174.pdf",
    });
    expect(orderRowAction({ id: "AX-10326", invoiceNumber: null, invoicePdfHref: null })).toEqual({
      kind: "view",
      label: "View",
      icon: "open_in_new",
      href: "/orders/AX-10326",
      ariaLabel: "View order AX-10326",
    });
  });
});

describe("copy", () => {
  it("mentions guest checkouts only when they land in this account", () => {
    expect(ordersDescription("priya@sharmamedicals.example")).toBe(
      "All purchases for this business, including guest checkouts with priya@sharmamedicals.example. Export for your accountant.",
    );
    expect(ordersDescription(null)).toBe("All purchases for this business. Export for your accountant.");
  });

  it("reports exported rows like the prototype", () => {
    expect(exportToastMessage(6, "orders.csv")).toBe("Exported 6 rows to orders.csv");
    expect(exportToastMessage(1, "orders.csv")).toBe("Exported 1 row to orders.csv");
    expect(exportToastMessage(10000, "orders.csv", true)).toBe(
      "Exported 10,000 rows to orders.csv. Narrow the filters to export the rest.",
    );
  });

  it("reads the export headers defensively", () => {
    const headers = (h: Record<string, string>) => new Headers(h);
    expect(exportResult(headers({ "X-Export-Rows": "12", "X-Export-Truncated": "0" }))).toEqual({ rows: 12, truncated: false });
    expect(exportResult(headers({ "X-Export-Rows": "10000", "X-Export-Truncated": "1" }))).toEqual({ rows: 10000, truncated: true });
    expect(exportResult(headers({ "X-Export-Rows": "-1" }))).toEqual({ rows: null, truncated: false });
    expect(exportResult(headers({}))).toEqual({ rows: null, truncated: false });
  });
});
