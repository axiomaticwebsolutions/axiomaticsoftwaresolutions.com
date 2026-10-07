/**
 * Account data export (Security > "Account data" > "Export data"; decisions.md Phase 5): one JSON document with the
 * active business account's details, team, locations, licenses, devices, orders, invoices, payments, support tickets
 * and activity log. Owner only (team permission `team.manage`, checked by the route), rate limited by the route.
 *
 * Never included: license keys (only the masked form with the last four characters), key hashes or ciphertexts,
 * password hashes, device fingerprints, storage keys of attachments, staff-only ticket notes, and email addresses or
 * phone numbers of people other than the account's own team members (order billing snapshots keep the invoice
 * details: name, business, address, GSTIN). Each collection is capped; `truncated` says which ones were cut.
 */
import "server-only";
import type { Db } from "@/lib/db";
import { maskLicenseKey } from "@/lib/licensing/keys";
import { deriveLicenseStatus } from "@/lib/licensing/status";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { retentionCutoff } from "@/lib/portal/activity";
import { TEAM_ROLE_META } from "@/lib/rbac";

export const EXPORT_FORMAT = "axiomatic-account-export";
export const EXPORT_VERSION = 1;
export const EXPORT_LIMITS = {
  licenses: 10_000,
  devices: 20_000,
  orders: 10_000,
  payments: 20_000,
  tickets: 2_000,
  messagesPerTicket: 200,
  activity: 20_000,
} as const;

type Iso = string;
const iso = (d: Date | null | undefined): Iso | null => (d ? d.toISOString() : null);

export type AccountExport = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: Iso;
  exportedBy: { name: string; email: string };
  account: { id: string; legalName: string; gstin: string | null; address: string | null; city: string | null; state: string | null; pin: string | null; createdAt: Iso };
  team: Array<{ name: string; email: string; role: string; roleLabel: string; status: string; joinedAt: Iso }>;
  locations: Array<{ id: string; name: string }>;
  licenses: Array<{
    id: string;
    productId: string;
    product: string;
    plan: string;
    planType: string;
    status: string;
    keyMasked: string;
    issuedAt: Iso;
    expiresAt: Iso | null;
    updatesUntil: Iso;
    deviceLimit: number;
    orderId: string | null;
  }>;
  devices: Array<{
    id: string;
    licenseId: string;
    name: string;
    os: string;
    appVersion: string | null;
    location: string | null;
    activatedAt: Iso;
    lastSeenAt: Iso;
    deactivatedAt: Iso | null;
    deactivatedBy: string | null;
  }>;
  orders: Array<{
    id: string;
    status: string;
    createdAt: Iso;
    paidAt: Iso | null;
    placedBy: string | null;
    couponCode: string | null;
    placeOfSupply: string;
    billing: { name: string; business: string | null; address: string; city: string; state: string; pin: string; gstin: string | null };
    amountsPaise: { subtotal: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; total: number };
    items: Array<{
      product: string;
      plan: string;
      kind: string;
      quantity: number;
      unitPricePaise: number;
      discountPaise: number;
      taxablePaise: number;
      taxPaise: number;
      targetLicenseId: string | null;
      issuedLicenseId: string | null;
    }>;
  }>;
  invoices: Array<{ number: string; orderId: string; issuedAt: Iso; sac: string }>;
  payments: Array<{ orderId: string; reference: string; method: string | null; status: string; amountPaise: number; createdAt: Iso; capturedAt: Iso | null }>;
  tickets: Array<{
    id: string;
    subject: string;
    status: string;
    priority: string;
    productId: string | null;
    licenseId: string | null;
    createdAt: Iso;
    updatedAt: Iso;
    resolvedAt: Iso | null;
    closedAt: Iso | null;
    messages: Array<{ from: string; fromSupport: boolean; body: string; createdAt: Iso; attachments: Array<{ name: string; sizeBytes: number | null }> }>;
  }>;
  activity: Array<{ at: Iso; actor: string; action: string; item: string; kind: string }>;
  /** Collections cut at EXPORT_LIMITS (the newest rows are kept where it matters: activity, payments). */
  truncated: string[];
};

/** Attachment names and sizes only (never the private storage key). */
export function exportAttachments(json: unknown): Array<{ name: string; sizeBytes: number | null }> {
  if (!Array.isArray(json)) return [];
  return json.flatMap((a: unknown) => {
    if (a === null || typeof a !== "object") return [];
    const { name, sizeBytes } = a as Record<string, unknown>;
    if (typeof name !== "string") return [];
    return [{ name, sizeBytes: typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? sizeBytes : null }];
  });
}

/** "account-export-2026-10-07.json" (IST date is not needed here: the date is informational). */
export function exportFileName(now: Date): string {
  return `account-export-${now.toISOString().slice(0, 10)}.json`;
}

export type BuildExportInput = { accountId: string; exportedBy: { name: string; email: string }; now?: Date };

/** Collects the export document for the caller's active account. */
export async function buildAccountExport(client: Db, input: BuildExportInput): Promise<AccountExport> {
  const now = input.now ?? new Date();
  const { accountId } = input;
  const truncated: string[] = [];
  const cut = <T>(name: string, rows: T[], limit: number): T[] => {
    if (rows.length <= limit) return rows;
    truncated.push(name);
    return rows.slice(0, limit);
  };

  const account = await client.businessAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { id: true, legalName: true, gstin: true, address: true, city: true, state: true, pin: true, createdAt: true },
  });
  const members = await client.accountMember.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { role: true, status: true, createdAt: true, user: { select: { name: true, email: true } } },
  });
  const locations = await client.location.findMany({
    where: { accountId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  const licenses = cut(
    "licenses",
    await client.license.findMany({
      where: { accountId },
      orderBy: { id: "asc" },
      take: EXPORT_LIMITS.licenses + 1,
      select: {
        id: true,
        status: true,
        keyLast4: true,
        issuedAt: true,
        expiresAt: true,
        updatesUntil: true,
        deviceLimit: true,
        orderId: true,
        product: { select: { id: true, code: true, name: true } },
        plan: { select: { name: true, type: true } },
      },
    }),
    EXPORT_LIMITS.licenses,
  );
  const devices = cut(
    "devices",
    await client.deviceActivation.findMany({
      where: { license: { accountId } },
      orderBy: [{ licenseId: "asc" }, { activatedAt: "asc" }, { id: "asc" }],
      take: EXPORT_LIMITS.devices + 1,
      select: {
        id: true,
        licenseId: true,
        name: true,
        os: true,
        appVersion: true,
        activatedAt: true,
        lastSeenAt: true,
        deactivatedAt: true,
        deactivatedBy: true,
        location: { select: { name: true } },
      },
    }),
    EXPORT_LIMITS.devices,
  );
  const orders = cut(
    "orders",
    await client.order.findMany({
      where: { accountId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_LIMITS.orders + 1,
      select: {
        id: true,
        status: true,
        createdAt: true,
        paidAt: true,
        couponCode: true,
        placeOfSupply: true,
        billing: true,
        subtotalPaise: true,
        discountPaise: true,
        taxablePaise: true,
        cgstPaise: true,
        sgstPaise: true,
        igstPaise: true,
        totalPaise: true,
        placedBy: { select: { name: true } },
        invoice: { select: { number: true, issuedAt: true, sac: true } },
        items: {
          orderBy: { id: "asc" },
          select: {
            kind: true,
            quantity: true,
            unitPricePaise: true,
            discountPaise: true,
            taxablePaise: true,
            taxPaise: true,
            targetLicenseId: true,
            issuedLicenseId: true,
            plan: { select: { name: true, product: { select: { name: true } } } },
          },
        },
      },
    }),
    EXPORT_LIMITS.orders,
  );
  const payments = cut(
    "payments",
    await client.payment.findMany({
      where: { order: { accountId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_LIMITS.payments + 1,
      select: { id: true, orderId: true, providerPaymentId: true, method: true, status: true, amountPaise: true, createdAt: true, capturedAt: true },
    }),
    EXPORT_LIMITS.payments,
  );
  const tickets = cut(
    "tickets",
    await client.supportTicket.findMany({
      where: { accountId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_LIMITS.tickets + 1,
      select: {
        id: true,
        subject: true,
        status: true,
        priority: true,
        productId: true,
        licenseId: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        closedAt: true,
        messages: {
          // Staff-only notes never leave the support console.
          where: { internal: false },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: EXPORT_LIMITS.messagesPerTicket,
          select: { isStaff: true, body: true, createdAt: true, attachments: true, author: { select: { name: true } } },
        },
      },
    }),
    EXPORT_LIMITS.tickets,
  );
  const activity = cut(
    "activity",
    await client.accountActivity.findMany({
      where: { accountId, createdAt: { gte: retentionCutoff(now) } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_LIMITS.activity + 1,
      select: { createdAt: true, actorName: true, action: true, target: true, kind: true },
    }),
    EXPORT_LIMITS.activity,
  );

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    exportedBy: input.exportedBy,
    account: { ...account, createdAt: account.createdAt.toISOString() },
    team: members.map((m) => ({
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      roleLabel: TEAM_ROLE_META[m.role].label,
      status: m.status,
      joinedAt: m.createdAt.toISOString(),
    })),
    locations,
    licenses: licenses.map((l) => ({
      id: l.id,
      productId: l.product.id,
      product: l.product.name,
      plan: l.plan.name,
      planType: l.plan.type,
      status: deriveLicenseStatus(l, now),
      keyMasked: maskLicenseKey(l.product.code, l.keyLast4),
      issuedAt: l.issuedAt.toISOString(),
      expiresAt: iso(l.expiresAt),
      updatesUntil: l.updatesUntil.toISOString(),
      deviceLimit: l.deviceLimit,
      orderId: l.orderId,
    })),
    devices: devices.map((d) => ({
      id: d.id,
      licenseId: d.licenseId,
      name: d.name,
      os: d.os,
      appVersion: d.appVersion,
      location: d.location?.name ?? null,
      activatedAt: d.activatedAt.toISOString(),
      lastSeenAt: d.lastSeenAt.toISOString(),
      deactivatedAt: iso(d.deactivatedAt),
      deactivatedBy: d.deactivatedBy,
    })),
    orders: orders.map((o) => {
      const billing = readBillingSnapshot(o.billing);
      return {
        id: o.id,
        status: o.status,
        createdAt: o.createdAt.toISOString(),
        paidAt: iso(o.paidAt),
        placedBy: o.placedBy ? o.placedBy.name : null,
        couponCode: o.couponCode,
        placeOfSupply: o.placeOfSupply,
        billing: {
          name: billing.name,
          business: billing.business,
          address: billing.address,
          city: billing.city,
          state: billing.state,
          pin: billing.pin,
          gstin: billing.gstin,
        },
        amountsPaise: {
          subtotal: o.subtotalPaise,
          discount: o.discountPaise,
          taxable: o.taxablePaise,
          cgst: o.cgstPaise,
          sgst: o.sgstPaise,
          igst: o.igstPaise,
          total: o.totalPaise,
        },
        items: o.items.map((i) => ({
          product: i.plan.product.name,
          plan: i.plan.name,
          kind: i.kind,
          quantity: i.quantity,
          unitPricePaise: i.unitPricePaise,
          discountPaise: i.discountPaise,
          taxablePaise: i.taxablePaise,
          taxPaise: i.taxPaise,
          targetLicenseId: i.targetLicenseId,
          issuedLicenseId: i.issuedLicenseId,
        })),
      };
    }),
    invoices: orders.flatMap((o) =>
      o.invoice ? [{ number: o.invoice.number, orderId: o.id, issuedAt: o.invoice.issuedAt.toISOString(), sac: o.invoice.sac }] : [],
    ),
    payments: payments.map((p) => ({
      orderId: p.orderId,
      reference: p.providerPaymentId ?? p.id,
      method: p.method,
      status: p.status,
      amountPaise: p.amountPaise,
      createdAt: p.createdAt.toISOString(),
      capturedAt: iso(p.capturedAt),
    })),
    tickets: tickets.map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      productId: t.productId,
      licenseId: t.licenseId,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      resolvedAt: iso(t.resolvedAt),
      closedAt: iso(t.closedAt),
      messages: t.messages.map((m) => ({
        from: m.isStaff ? `${m.author.name} (Axiomatic support)` : m.author.name,
        fromSupport: m.isStaff,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        attachments: exportAttachments(m.attachments),
      })),
    })),
    activity: activity.map((a) => ({ at: a.createdAt.toISOString(), actor: a.actorName, action: a.action, item: a.target, kind: a.kind })),
    truncated,
  };
}

/**
 * Exports are plain GET downloads; a page on another site could still start one by navigation (cookies are
 * SameSite=Lax) and spend the rate limit. Browsers say where a request came from in Sec-Fetch-Site.
 */
export function isCrossSiteRequest(headers: Pick<Headers, "get">): boolean {
  return headers.get("sec-fetch-site") === "cross-site";
}
