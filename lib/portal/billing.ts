/**
 * Billing & tax details of the active business account (portal Billing page; decisions.md Phase 5).
 * - Details: legal name, GSTIN, registered address, city, State / UT, PIN. They prefill checkout and are printed on
 *   FUTURE invoices only: every order keeps its own billing snapshot (Order.billing), so past invoices never change.
 *   GSTIN rule: format + state-code consistency with the billing state (lib/validation/portal billingDetailsIssue).
 *   Saving a change logs "Updated billing details" with target "GSTIN {x}" or "No GSTIN" (kind billing, actor id).
 * - Invoice delivery contacts: ACTIVE Owner and Billing admin members (read-only; managed in Team & access).
 * - Payment history: payment attempts of the account's orders, newest first (no card or UPI data is stored).
 */
import "server-only";
import { TeamRole, type PaymentStatus, type Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { db as defaultDb } from "@/lib/db";
import { errors } from "@/lib/http";
import { recordAccountActivity } from "@/lib/portal/activity";
import { TEAM_ROLE_META } from "@/lib/rbac";
import { gstinStateName } from "@/lib/validation/gstin";
import { billingDetailsIssue, type BillingDetails, type BillingDetailsPatch } from "@/lib/validation/portal";

export const BILLING_ACTIVITY_ACTION = "Updated billing details";
export const PAYMENT_HISTORY_LIMIT = 100;
const INVOICE_CONTACT_ROLES: readonly TeamRole[] = [TeamRole.OWNER, TeamRole.BILLING];

export type BadgeTone = "sage" | "lavender" | "pink" | "peach" | "blue" | "slate";

/** Payment badges from the prototype (PB map). */
export const PAYMENT_STATUS_BADGES: Readonly<Record<PaymentStatus, { label: string; tone: BadgeTone }>> = Object.freeze({
  CAPTURED: { label: "Paid", tone: "sage" },
  REFUNDED: { label: "Refunded", tone: "lavender" },
  FAILED: { label: "Failed", tone: "pink" },
  PENDING: { label: "Pending", tone: "peach" },
  AUTHORIZED: { label: "Confirming", tone: "blue" },
  CANCELED: { label: "Canceled", tone: "slate" },
  CREATED: { label: "Started", tone: "slate" },
});

export type InvoiceContact = { userId: string; name: string; email: string; role: TeamRole; roleLabel: string };

export type PaymentHistoryRow = {
  id: string;
  /**
   * The payment partner's id ("pay_..."), or null before the partner reported one (started, canceled or failed
   * attempts): our internal attempt id is never shown (the UI renders "—" and payments.csv an empty cell).
   */
  reference: string | null;
  orderId: string;
  createdAt: string;
  /** "UPI", "Card", "Net banking", or null before a method is known. */
  method: string | null;
  status: PaymentStatus;
  badge: { label: string; tone: BadgeTone };
  amountPaise: number;
};

export type BillingView = {
  details: BillingDetails & {
    /** State the GSTIN is registered in (from its first two digits), or null. */
    gstinState: string | null;
  };
  invoiceContacts: InvoiceContact[];
  payments: PaymentHistoryRow[];
  /** More than PAYMENT_HISTORY_LIMIT payments exist (the newest are listed). */
  paymentsTruncated: boolean;
};

const DETAILS_SELECT = {
  legalName: true,
  gstin: true,
  address: true,
  city: true,
  state: true,
  pin: true,
} as const satisfies Prisma.BusinessAccountSelect;

function toDetails(row: Prisma.BusinessAccountGetPayload<{ select: typeof DETAILS_SELECT }>): BillingView["details"] {
  return {
    legalName: row.legalName,
    gstin: row.gstin,
    address: row.address,
    city: row.city,
    state: row.state,
    pin: row.pin,
    gstinState: row.gstin ? gstinStateName(row.gstin) : null,
  };
}

export async function listInvoiceContacts(client: Db, accountId: string): Promise<InvoiceContact[]> {
  const members = await client.accountMember.findMany({
    where: { accountId, status: "ACTIVE", role: { in: [...INVOICE_CONTACT_ROLES] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { role: true, user: { select: { id: true, name: true, email: true } } },
  });
  return members.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    roleLabel: TEAM_ROLE_META[m.role].label,
  }));
}

export async function listPaymentHistory(client: Db, accountId: string): Promise<{ rows: PaymentHistoryRow[]; truncated: boolean }> {
  const payments = await client.payment.findMany({
    where: { order: { accountId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAYMENT_HISTORY_LIMIT + 1,
    select: { id: true, providerPaymentId: true, orderId: true, createdAt: true, method: true, status: true, amountPaise: true },
  });
  return {
    rows: payments.slice(0, PAYMENT_HISTORY_LIMIT).map((p) => ({
      id: p.id,
      reference: p.providerPaymentId,
      orderId: p.orderId,
      createdAt: p.createdAt.toISOString(),
      method: p.method,
      status: p.status,
      badge: PAYMENT_STATUS_BADGES[p.status],
      amountPaise: p.amountPaise,
    })),
    truncated: payments.length > PAYMENT_HISTORY_LIMIT,
  };
}

/** GET /api/account/billing for the caller's active account. */
export async function getBilling(accountId: string, client: Db = defaultDb): Promise<BillingView> {
  const account = await client.businessAccount.findUnique({ where: { id: accountId }, select: DETAILS_SELECT });
  if (!account) throw errors.notFound("Account");
  const invoiceContacts = await listInvoiceContacts(client, accountId);
  const payments = await listPaymentHistory(client, accountId);
  return { details: toDetails(account), invoiceContacts, payments: payments.rows, paymentsTruncated: payments.truncated };
}

/** Merges a validated patch into the stored details (pure): omitted keys keep their value. */
export function mergeBillingDetails(current: BillingDetails, patch: BillingDetailsPatch): BillingDetails {
  return {
    legalName: patch.legalName ?? current.legalName,
    gstin: patch.gstin === undefined ? current.gstin : patch.gstin,
    address: patch.address === undefined ? current.address : patch.address,
    city: patch.city === undefined ? current.city : patch.city,
    state: patch.state === undefined ? current.state : patch.state,
    pin: patch.pin === undefined ? current.pin : patch.pin,
  };
}

const DETAIL_KEYS = ["legalName", "gstin", "address", "city", "state", "pin"] as const satisfies readonly (keyof BillingDetails)[];

/** "GSTIN 27ABCDE1234F1Z5" or "No GSTIN" (prototype activity target). */
export function billingActivityTarget(gstin: string | null): string {
  return gstin ? `GSTIN ${gstin}` : "No GSTIN";
}

export type UpdateBillingInput = {
  /** The caller's server-side active account (never from the client). */
  accountId: string;
  actor: { id: string; name: string };
  patch: BillingDetailsPatch;
  now?: Date;
};

/**
 * PATCH /api/account/billing. Locks the account row, merges, applies the GSTIN/state rule on the merged details
 * (422 fieldErrors.gstin / fieldErrors.state), saves and logs the activity entry in the same transaction. A save that
 * changes nothing writes nothing (`changed: false`).
 */
export async function updateBilling(
  input: UpdateBillingInput,
  client: typeof defaultDb = defaultDb,
): Promise<{ billing: BillingView; changed: boolean }> {
  const now = input.now ?? new Date();
  const changed = await client.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "BusinessAccount" WHERE "id" = ${input.accountId} FOR UPDATE`;
    if (locked.length === 0) throw errors.notFound("Account");
    const row = await tx.businessAccount.findUnique({ where: { id: input.accountId }, select: DETAILS_SELECT });
    if (!row) throw errors.notFound("Account");
    const current: BillingDetails = { ...row };
    const next = mergeBillingDetails(current, input.patch);
    const issue = billingDetailsIssue(next);
    if (issue) throw errors.validation({ [issue.field]: issue.message });
    if (DETAIL_KEYS.every((key) => next[key] === current[key])) return false;
    await tx.businessAccount.update({ where: { id: input.accountId }, data: next });
    await recordAccountActivity(tx, {
      accountId: input.accountId,
      actor: input.actor,
      action: BILLING_ACTIVITY_ACTION,
      target: billingActivityTarget(next.gstin),
      kind: "billing",
      at: now,
    });
    return true;
  });
  return { billing: await getBilling(input.accountId, client), changed };
}
