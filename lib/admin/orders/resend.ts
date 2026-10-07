/**
 * Resend invoice (orders.resend_invoice, every staff role): queues the "order_confirmation" email (order number,
 * invoice number, total and a fresh order link; never keys) with a new dedupe key, and audits "Resent invoice" per
 * order in the same transaction. Orders without an invoice are skipped, and so is an order whose confirmation is
 * still waiting in the outbox (a double click sends one email). Used by POST /api/admin/orders/:id/resend-invoice and
 * the bulk POST /api/admin/orders/resend-invoices.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { EmailStatus } from "@/generated/prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { db as defaultDb } from "@/lib/db";
import { enqueueEmail, kickEmailDispatch } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { getEnv } from "@/lib/env";
import { formatINR } from "@/lib/money";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { orderStatusPath, signOrderToken } from "@/lib/orders/token";
import type { ResendResponse } from "./model";

export const NO_INVOICE_REASON = "No invoice yet";
export const ALREADY_QUEUED_REASON = "Already queued";
export const NOT_FOUND_REASON = "Order not found";

export type ResendInvoicesInput = { ids: readonly string[]; actor: AuditActor; now?: Date };

/** Queues one invoice email per eligible order; returns what was queued and why the rest were skipped. */
export async function resendInvoices(input: ResendInvoicesInput): Promise<ResendResponse> {
  const now = input.now ?? new Date();
  const ids = [...new Set(input.ids)];
  const orders = await defaultDb.order.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      email: true,
      billing: true,
      totalPaise: true,
      placedBy: { select: { name: true } },
      invoice: { select: { number: true } },
    },
  });
  const byId = new Map(orders.map((o) => [o.id, o]));
  const result: ResendResponse = { queued: [], skipped: [] };
  for (const id of ids) {
    const order = byId.get(id);
    if (!order) {
      result.skipped.push({ id, reason: NOT_FOUND_REASON });
      continue;
    }
    if (!order.invoice) {
      result.skipped.push({ id, reason: NO_INVOICE_REASON });
      continue;
    }
    const invoiceNumber = order.invoice.number;
    const queued = await defaultDb.$transaction(async (tx) => {
      // Serialises concurrent resends of one order with each other (and with payment events).
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`;
      const waiting = await tx.outboxEmail.count({
        where: {
          templateId: "order_confirmation",
          status: { in: [EmailStatus.PENDING, EmailStatus.SENDING] },
          dedupeKey: { startsWith: `order_confirmation:${id}:resend:` },
        },
      });
      if (waiting > 0) return false;
      const name = readBillingSnapshot(order.billing).name.trim() || order.placedBy?.name || null;
      await enqueueEmail(tx, {
        to: order.email,
        templateId: "order_confirmation",
        vars: {
          customer_name: greetingName(name),
          order_id: id,
          order_url: `${getEnv().APP_URL}${orderStatusPath(id, signOrderToken(id, order.email, now))}`,
          total: formatINR(order.totalPaise, { exact: true }),
          invoice_number: invoiceNumber,
        },
        dedupeKey: `order_confirmation:${id}:resend:${now.getTime().toString(36)}${randomBytes(4).toString("hex")}`,
      });
      await audit(tx, input.actor, {
        action: "Resent invoice",
        target: id,
        targetType: "order",
        targetId: id,
        detail: `Invoice ${invoiceNumber} emailed to the order email`,
      });
      return true;
    });
    if (queued) result.queued.push(id);
    else result.skipped.push({ id, reason: ALREADY_QUEUED_REASON });
  }
  if (result.queued.length > 0) kickEmailDispatch();
  return result;
}
