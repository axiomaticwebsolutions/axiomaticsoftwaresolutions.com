/**
 * Tax invoice PDF: the loader reads the invoice snapshot of a paid order, react-pdf renders it with the embedded
 * fonts, and GET /api/orders/:id/invoice.pdf applies the order page's access rules. The session lookup
 * (next/headers) is replaced by a settable viewer; everything else is real.
 */
import { inflateSync } from "node:zlib";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Session, User } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { loadInvoiceModel } from "@/lib/invoice/load";
import { renderInvoicePdf } from "@/lib/invoice/pdf";
import { getPaymentProvider } from "@/lib/payments";
import type { MockProvider } from "@/lib/payments/mock";
import { processPaymentEvent } from "@/lib/payments/webhook";
import { authOf, makeCustomer, placeOrder, seedCatalog, uniq, type CatalogFixture, type CustomerFixture } from "./checkout-fixtures";

const state = vi.hoisted(() => ({ auth: null as { user: User; session: Session } | null }));
vi.mock("@/lib/auth/guards", () => ({ getCurrentAuth: async () => state.auth }));

const { GET: invoiceRoute } = await import("@/app/api/orders/[id]/invoice.pdf/route");

const BASE = "http://localhost:3000";
let cat: CatalogFixture;
let stranger: CustomerFixture;

beforeAll(async () => {
  cat = await seedCatalog();
  stranger = await makeCustomer({ role: "OWNER" });
});

/** Pays an order through the real webhook handler (invoice number, seller snapshot, licenses). */
async function pay(orderId: string): Promise<void> {
  const payment = await db.payment.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: "desc" } });
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const mock = getPaymentProvider("mock") as MockProvider;
  const event = mock.buildWebhook({
    type: "payment.captured",
    providerOrderId: payment.providerOrderId,
    providerPaymentId: `pay_${uniq("inv").replace(/-/g, "")}`,
    amountPaise: order.totalPaise,
    method: "UPI",
  }).event;
  expect(await processPaymentEvent("mock", event)).toMatchObject({ result: "fulfilled" });
}

async function get(orderId: string, token?: string): Promise<Response> {
  const url = `${BASE}/api/orders/${encodeURIComponent(orderId)}/invoice.pdf${token ? `?t=${encodeURIComponent(token)}` : ""}`;
  return invoiceRoute(new NextRequest(url, { method: "GET" }), { params: Promise.resolve({ id: orderId }) });
}

/** Text drawn on the PDF pages (font subsets encode glyph ids, so check structure, not words). */
function pdfStreams(buf: Buffer): string[] {
  const out: string[] = [];
  const raw = buf.toString("latin1");
  let at = 0;
  for (;;) {
    const start = raw.indexOf("stream", at);
    if (start < 0) break;
    const begin = raw[start + 6] === "\r" ? start + 8 : start + 7;
    const end = raw.indexOf("endstream", begin);
    if (end < 0) break;
    try {
      out.push(inflateSync(buf.subarray(begin, end)).toString("latin1"));
    } catch {
      // not a deflate stream (fonts are compressed differently or not at all)
    }
    at = end + 9;
  }
  return out;
}

describe("invoice PDF", () => {
  it("renders a paid order's invoice from its snapshot", async () => {
    const order = await placeOrder(null, {
      email: `${uniq("inv")}@example.test`,
      items: [{ planId: cat.plans.annual.id, qty: 1 }, { planId: cat.plans.perUnit.id, qty: 2 }],
    });
    expect(await loadInvoiceModel(db, order.orderId)).toBeNull(); // unpaid: no invoice yet
    await pay(order.orderId);

    const model = await loadInvoiceModel(db, order.orderId);
    expect(model).not.toBeNull();
    const invoice = await db.invoice.findUniqueOrThrow({ where: { orderId: order.orderId } });
    expect(model).toMatchObject({ isInvoice: true, number: invoice.number, sac: invoice.sac, supply: "intra", totalLabel: "Total paid" });
    expect(model?.lines).toHaveLength(2);
    expect(model?.lines.reduce((a, l) => a + l.amountPaise, 0)).toBe(model?.totalPaise);

    const pdf = await renderInvoicePdf(model!);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5_000);
    const raw = pdf.toString("latin1");
    // Embedded Manrope (main + latin-ext fallback for the rupee sign) and JetBrains Mono subsets.
    expect(raw).toMatch(/FontName\s*\/[A-Z]{6}\+Manrope/);
    expect(raw).not.toMatch(/Helvetica/);
    expect(pdfStreams(pdf).length).toBeGreaterThan(0);
  });

  it("serves the PDF to the order link holder as an attachment, never cached", async () => {
    const order = await placeOrder(null, { email: `${uniq("inv")}@example.test` });
    await pay(order.orderId);
    state.auth = null;
    const res = await get(order.orderId, order.orderToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const invoice = await db.invoice.findUniqueOrThrow({ where: { orderId: order.orderId } });
    const fileName = `Invoice-${invoice.number.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${fileName}"`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Number(res.headers.get("content-length"))).toBe(body.length);
  });

  it("refuses unpaid orders, strangers and bad links", async () => {
    const order = await placeOrder(null, { email: `${uniq("inv")}@example.test` });
    state.auth = null;
    const unpaid = await get(order.orderId, order.orderToken);
    expect(unpaid.status).toBe(409);
    expect(await unpaid.json()).toMatchObject({ error: { code: "invoice_unavailable" } });

    await pay(order.orderId);
    expect((await get(order.orderId)).status).toBe(401); // signed out, no link
    expect((await get(order.orderId, `${order.orderToken.slice(0, -2)}xx`)).status).toBe(404);
    expect((await get("AX-99999999", order.orderToken)).status).toBe(404);

    state.auth = authOf(stranger);
    const foreign = await get(order.orderId);
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("cache-control")).toContain("no-store");
    state.auth = null;
  });

  it("serves account members their own invoice", async () => {
    const owner = await makeCustomer({ role: "OWNER" });
    const order = await placeOrder(authOf(owner), { email: owner.user.email });
    await pay(order.orderId);
    state.auth = authOf(owner);
    const res = await get(order.orderId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    state.auth = null;
  });
});
