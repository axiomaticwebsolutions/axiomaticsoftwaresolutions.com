/**
 * Fixtures for the admin Overview and Reports DB tests (tests/db/admin-overview-*.test.ts, admin-reports-*.test.ts).
 * Not a test file. Windowed figures are computed at NOW (June 2031), a period no other test file writes to, so the
 * tests can expect exact sums; figures that span all time (license health, open tickets, needs attention) are checked
 * as differences from a baseline taken before the rows are created. Builds on the portal API fixtures.
 */
import { randomBytes } from "node:crypto";
import type { RefundStatus, TicketPriority, TicketStatus } from "@/generated/prisma/client";
import { db } from "@/lib/db";

export { addPayment, DAY, makeCatalog, makeLicense, makeMember, makeOrder, type Catalog } from "./portal-api-fixtures";

export const tag = () => randomBytes(4).toString("hex").toUpperCase();

/** 15 Jun 2031, 12:00 IST. */
export const NOW = new Date("2031-06-15T06:30:00.000Z");

/** `days` days before NOW. */
export const daysBefore = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

/** An IST date-time as a Date ("2031-05-20", hour in IST, default noon). */
export const ist = (isoDay: string, hour = 12) => new Date(`${isoDay}T${String(hour).padStart(2, "0")}:00:00.000+05:30`);

export const invoiceNo = () => `AXT/31-32/${tag()}`;
export const creditNoteNo = () => `AXCT/31-32/${tag()}`;

/** A refund (credit note when `creditNote` is set) of `amountPaise` on a payment, at `createdAt`. */
export async function makeRefund(
  paymentId: string,
  amountPaise: number,
  opts: { status?: RefundStatus; creditNote?: boolean; createdAt?: Date; processedAt?: Date | null } = {},
) {
  const status = opts.status ?? "PROCESSED";
  return db.refund.create({
    data: {
      paymentId,
      amountPaise,
      reason: "Reports test refund",
      createdById: "staff-test",
      status,
      creditNoteNo: opts.creditNote === false ? null : creditNoteNo(),
      createdAt: opts.createdAt ?? NOW,
      processedAt: opts.processedAt === undefined ? (status === "PROCESSED" ? (opts.createdAt ?? NOW) : null) : opts.processedAt,
    },
  });
}

/** A webhook delivery with `result`, received at `receivedAt`. */
export async function makeDelivery(result: string, receivedAt: Date) {
  return db.webhookDelivery.create({
    data: { provider: "mock", eventId: `evt_${tag()}`, type: "payment.captured", signatureOk: result !== "invalid_signature", result, receivedAt },
  });
}

/** A support ticket with explicit status, priority, assignee and timestamps. */
export async function makeStaffTicket(
  accountId: string,
  opts: {
    status?: TicketStatus;
    priority?: TicketPriority;
    assigneeId?: string | null;
    createdAt?: Date;
    firstResponseAt?: Date | null;
    resolvedAt?: Date | null;
  } = {},
) {
  return db.supportTicket.create({
    data: {
      id: `T-R${tag()}`,
      accountId,
      subject: `Reports test ${tag()}`,
      status: opts.status ?? "OPEN",
      priority: opts.priority ?? "NORMAL",
      assigneeId: opts.assigneeId ?? null,
      createdAt: opts.createdAt ?? NOW,
      firstResponseAt: opts.firstResponseAt ?? null,
      resolvedAt: opts.resolvedAt ?? null,
    },
  });
}
