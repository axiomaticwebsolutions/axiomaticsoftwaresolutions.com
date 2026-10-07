/**
 * Fixtures for the portal API DB tests (tests/db/portal-api-*.test.ts). Not a test file itself. Builds on the license
 * action fixtures (catalog, members, licenses, devices, signed-in route calls) and adds orders with snapshots,
 * invoices, payments and refunds, tickets, notifications and activity rows. Ids are unique per call because DB test
 * files share one schema per run.
 */
import { randomBytes } from "node:crypto";
import type { ItemKind, OrderStatus, Plan, TicketStatus } from "@/generated/prisma/client";
import { db } from "@/lib/db";

export {
  bodyOf,
  call,
  DAY,
  errorOf,
  makeCatalog,
  makeDevice,
  makeLicense,
  makeLocation,
  makeMember,
  PASSWORD,
  signIn,
  type Catalog,
  type Member,
} from "./license-actions-fixtures";

export const tag = () => randomBytes(4).toString("hex").toUpperCase();

export type OrderLine = { plan: Plan; qty?: number; taxablePaise: number; taxPaise: number; kind?: ItemKind };

export type OrderOptions = {
  accountId: string | null;
  status?: OrderStatus;
  lines: OrderLine[];
  createdAt?: Date;
  paidAt?: Date | null;
  placedByUserId?: string | null;
  invoiceNumber?: string | null;
  invoiceIssuedAt?: Date;
  placeOfSupply?: string;
  interState?: boolean;
  billing?: Record<string, unknown>;
  email?: string;
};

/** An order with snapshot amounts: CGST/SGST split of the line taxes (IGST when interState), total = taxable + tax. */
export async function makeOrder(opts: OrderOptions) {
  const id = `AX-T${tag()}`;
  const taxable = opts.lines.reduce((s, l) => s + l.taxablePaise, 0);
  const tax = opts.lines.reduce((s, l) => s + l.taxPaise, 0);
  const cgst = opts.interState ? 0 : Math.round(tax / 2);
  const sgst = opts.interState ? 0 : tax - cgst;
  const createdAt = opts.createdAt ?? new Date();
  const status = opts.status ?? "PAID";
  const order = await db.order.create({
    data: {
      id,
      accountId: opts.accountId,
      email: opts.email ?? `buyer.${tag().toLowerCase()}@example.test`,
      billing: (opts.billing ?? { name: "Priya Sharma", state: "Maharashtra", gstin: "27ABCDE1234F1Z5" }) as never,
      status,
      subtotalPaise: taxable,
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: opts.interState ? tax : 0,
      totalPaise: taxable + tax,
      placeOfSupply: opts.placeOfSupply ?? "Maharashtra",
      placedByUserId: opts.placedByUserId ?? null,
      createdAt,
      paidAt: opts.paidAt === undefined ? (status === "PAID" || status.includes("REFUNDED") ? createdAt : null) : opts.paidAt,
      items: {
        create: opts.lines.map((l) => ({
          planId: l.plan.id,
          kind: l.kind ?? "NEW",
          quantity: l.qty ?? 1,
          unitPricePaise: Math.round(l.taxablePaise / (l.qty ?? 1)),
          taxablePaise: l.taxablePaise,
          taxPaise: l.taxPaise,
        })),
      },
    },
  });
  if (opts.invoiceNumber) {
    await db.invoice.create({
      data: {
        number: opts.invoiceNumber,
        orderId: id,
        seller: { legalName: "Axiomatic (sample)", gstin: "27AAACA1234B1Z2", state: "Maharashtra" },
        issuedAt: opts.invoiceIssuedAt ?? order.paidAt ?? createdAt,
      },
    });
  }
  return order;
}

/** A captured payment for the order and, when `refundedPaise` is set, a PROCESSED refund of that amount. */
export async function addPayment(orderId: string, amountPaise: number, opts: { refundedPaise?: number; method?: string; status?: "CAPTURED" | "REFUNDED" | "FAILED" } = {}) {
  const payment = await db.payment.create({
    data: {
      orderId,
      provider: "mock",
      providerOrderId: `mock_order_${tag()}`,
      providerPaymentId: `pay_${tag()}`,
      method: opts.method ?? "UPI",
      amountPaise,
      status: opts.status ?? "CAPTURED",
      capturedAt: new Date(),
    },
  });
  if (opts.refundedPaise) {
    await db.refund.create({
      data: { paymentId: payment.id, amountPaise: opts.refundedPaise, reason: "Test refund", createdById: "staff-test", status: "PROCESSED", processedAt: new Date() },
    });
  }
  return payment;
}

export async function makeTicket(accountId: string, opts: { status?: TicketStatus; subject?: string; updatedAt?: Date } = {}) {
  const ticket = await db.supportTicket.create({
    data: { id: `T-T${tag()}`, accountId, subject: opts.subject ?? `Printer stopped ${tag()}`, status: opts.status ?? "OPEN" },
  });
  if (opts.updatedAt) {
    await db.$executeRaw`UPDATE "SupportTicket" SET "updatedAt" = ${opts.updatedAt} WHERE "id" = ${ticket.id}`;
  }
  return ticket;
}

export async function makeActivity(accountId: string, opts: { action?: string; at?: Date; actorName?: string } = {}) {
  return db.accountActivity.create({
    data: {
      accountId,
      actorName: opts.actorName ?? "Priya Sharma",
      action: opts.action ?? `Did something ${tag()}`,
      target: "LIC-1",
      kind: "license",
      createdAt: opts.at ?? new Date(),
    },
  });
}

export async function makeNotification(userId: string, opts: { read?: boolean; at?: Date; href?: string | null; kind?: string } = {}) {
  return db.notification.create({
    data: {
      userId,
      kind: opts.kind ?? "renewal",
      title: `Renewal due ${tag()}`,
      body: "Medical Store Billing ends soon.",
      href: opts.href === undefined ? "/account/licenses" : opts.href,
      readAt: opts.read ? new Date() : null,
      createdAt: opts.at ?? new Date(),
    },
  });
}
