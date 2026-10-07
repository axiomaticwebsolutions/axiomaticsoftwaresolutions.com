/**
 * GET /api/account/orders and /api/account/orders/export.csv: account scoping (other accounts' and unclaimed guest
 * orders never appear), paging (8), filters, search by invoice number, sort, placed-by labels, every role may read,
 * and the accountant CSV (BOM, GST split in rupees, IST dates, formula guard, filters applied, cross-site refused).
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as exportGET } from "@/app/api/account/orders/export.csv/route";
import { GET as ordersGET } from "@/app/api/account/orders/route";
import { getEnv } from "@/lib/env";
import type { AccountOrderList } from "@/lib/portal/orders";
import { call, DAY, makeCatalog, makeMember, makeOrder, signIn, tag, type Catalog, type Member } from "./portal-api-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: { maxAge?: number } = {}) => {
      if (options.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

const now = Date.now();
const at = (days: number) => new Date(now + days * DAY);

let A: Catalog;
let owner: Member;
let viewer: Member;
let rohan: Member;
let ids: string[];
let invoiceNo: string;
let foreignId: string;
let guestId: string;

beforeAll(async () => {
  A = await makeCatalog();
  owner = await makeMember({ name: "Priya Sharma" });
  viewer = await makeMember({ accountId: owner.accountId, role: "VIEWER" });
  rohan = await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Rohan Sharma" });
  invoiceNo = `AXS/T${tag()}/1181`;
  const statuses = ["PAID", "PAID", "PAID", "REFUNDED", "PARTIALLY_REFUNDED", "FAILED", "CANCELED", "AWAITING_PAYMENT", "PENDING", "REVIEW"] as const;
  ids = [];
  for (const [i, status] of statuses.entries()) {
    const order = await makeOrder({
      accountId: owner.accountId,
      status,
      createdAt: at(-30 + i),
      placedByUserId: i === 0 ? rohan.user.id : null,
      invoiceNumber: i === 0 ? invoiceNo : status === "PAID" ? `AXS/T${tag()}/9` : null,
      lines: [{ plan: A.annual, qty: i === 1 ? 2 : 1, taxablePaise: 100_000 * (i + 1), taxPaise: 18_000 * (i + 1) }],
      placeOfSupply: i === 2 ? "=1+1" : "Maharashtra",
      interState: i === 1,
    });
    ids.push(order.id);
  }
  const stranger = await makeMember();
  foreignId = (await makeOrder({ accountId: stranger.accountId, lines: [{ plan: A.annual, taxablePaise: 1, taxPaise: 0 }] })).id;
  guestId = (await makeOrder({ accountId: null, lines: [{ plan: A.annual, taxablePaise: 1, taxPaise: 0 }] })).id;
});

const list = async (query = "", member: Member = owner) => {
  await signIn(jar, member);
  const res = await call(jar, ordersGET, `/api/account/orders${query}`);
  return { res, body: (await res.json()) as AccountOrderList };
};

/** The export request a browser sends when another site navigates to it. */
const crossSiteExport = () => {
  const headers = new Headers({ "sec-fetch-site": "cross-site" });
  headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  return exportGET(new NextRequest(`${getEnv().APP_URL}/api/account/orders/export.csv`, { headers }), undefined as never);
};

describe("GET /api/account/orders", () => {
  it("pages the account's orders newest first, 8 at a time", async () => {
    const { res, body } = await list();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ total: 10, page: 1, pageSize: 8, pageCount: 2 });
    expect(body.orders.map((o) => o.id)).toEqual([...ids].reverse().slice(0, 8));
    const page2 = (await list("?page=2")).body;
    expect(page2.orders.map((o) => o.id)).toEqual([ids[1], ids[0]]);
    expect((await list("?page=99")).body.page).toBe(2);
    const all = [...body.orders, ...page2.orders].map((o) => o.id);
    expect(all).not.toContain(foreignId);
    expect(all).not.toContain(guestId);
  });

  it("describes each row: badge, items, placed by, invoice, GST and links", async () => {
    const rows = [...(await list()).body.orders, ...(await list("?page=2")).body.orders];
    expect(rows.find((o) => o.id === ids[0])).toMatchObject({
      status: "PAID",
      badge: { label: "Paid", tone: "sage" },
      summary: `Medical \u00b7 ${A.annual.name}`,
      placedByName: "Rohan Sharma",
      placedByLabel: "by Rohan Sharma",
      invoiceNumber: invoiceNo,
      taxablePaise: 100_000,
      cgstPaise: 9_000,
      sgstPaise: 9_000,
      taxPaise: 18_000,
      totalPaise: 118_000,
      href: `/orders/${ids[0]}`,
      invoicePdfHref: `/api/orders/${ids[0]}/invoice.pdf`,
    });
    expect(rows.find((o) => o.id === ids[1])).toMatchObject({
      summary: `Medical \u00b7 ${A.annual.name} \u00d72`,
      igstPaise: 36_000,
      placedByLabel: "Guest checkout",
    });
    expect(rows.find((o) => o.id === ids[7])).toMatchObject({ badge: { label: "Unpaid", tone: "slate" }, invoicePdfHref: null });
    expect(rows.find((o) => o.id === ids[4])?.badge.label).toBe("Partly refunded");
  });

  it("filters by status group, searches order ids and invoice numbers, sorts by total", async () => {
    expect((await list("?status=paid")).body.orders.map((o) => o.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect((await list("?status=refunded")).body.orders.map((o) => o.id)).toEqual([ids[4], ids[3]]);
    expect((await list("?status=pending")).body.total).toBe(3);
    const partialInvoice = encodeURIComponent(invoiceNo.slice(0, 12).toLowerCase());
    expect((await list(`?q=${partialInvoice}`)).body.orders.map((o) => o.id)).toEqual([ids[0]]);
    expect((await list(`?q=${ids[5]}`)).body.orders.map((o) => o.id)).toEqual([ids[5]]);
    expect((await list("?sort=total")).body.orders[0]?.id).toBe(ids[0]);
    expect((await list("?sort=-total")).body.orders[0]?.id).toBe(ids[9]);
    expect((await list("?status=everything")).res.status).toBe(422);
  });

  it("is readable by every team role (Viewer included)", async () => {
    expect((await list("", viewer)).body.total).toBe(10);
  });
});

describe("GET /api/account/orders/export.csv", () => {
  it("exports every filtered order with the GST split for accountants", async () => {
    await signIn(jar, viewer);
    const res = await call(jar, exportGET, "/api/account/orders/export.csv?status=paid&sort=date");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv;charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain('filename="orders.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-export-rows")).toBe("3");
    // The UTF-8 byte order mark (EF BB BF) lets Excel read the file as UTF-8; TextDecoder keeps it with ignoreBOM.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe(
      '"Order","Date","Invoice","Status","Taxable","CGST","SGST","IGST","Total","Invoice date","Place of supply","Billed GSTIN","Seller GSTIN"',
    );
    expect(lines).toHaveLength(5); // header, 3 rows, trailing empty line
    expect(lines[1]).toContain(`"${ids[0]}"`);
    expect(lines[1]).toContain('"Paid","1000.00","90.00","90.00","0.00","1180.00"');
    expect(lines[1]).toContain('"27ABCDE1234F1Z5","27AAACA1234B1Z2"');
    expect(lines[2]).toContain('"2000.00","0.00","0.00","360.00","2360.00"');
    // A formula-like value is neutralised for spreadsheets.
    expect(lines[3]).toContain(`"'=1+1"`);
  });

  it("refuses cross-site requests; other accounts' exports never include this account", async () => {
    await signIn(jar, owner);
    expect((await crossSiteExport()).status).toBe(403);
    const stranger = await makeMember();
    await signIn(jar, stranger);
    const text = await (await call(jar, exportGET, "/api/account/orders/export.csv")).text();
    expect(text).not.toContain(ids[0]);
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});
