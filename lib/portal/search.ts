/**
 * Portal global search (top bar, Ctrl K; decisions.md Phase 5): licenses (license id, product name, key last 4, or a
 * full pasted key matched by its keyed hash), devices (name), orders (order id, invoice number) and tickets (ticket id,
 * subject) of the ACTIVE business account only. At least 2 characters; at most SEARCH_PER_TYPE results per type and
 * SEARCH_LIMIT in all, in the prototype's order (licenses, devices, orders, tickets). Keys are always masked; the
 * query text is never logged. Every team role may search (they can all view licenses, invoices and tickets).
 */
import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { getLicenseKeySecrets } from "@/lib/env";
import { hashLicenseKey } from "@/lib/licensing/crypto";
import { isLicenseKeyFormat, maskLicenseKey, normalizeLicenseKey } from "@/lib/licensing/keys";
import { formatINR } from "@/lib/money";

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_LIMIT = 20;
export const SEARCH_PER_TYPE = 8;

export type SearchResultType = "license" | "device" | "order" | "ticket";

export type SearchResult = {
  type: SearchResultType;
  /** Prototype right-hand label: LICENSE / DEVICE / ORDER / TICKET. */
  typeLabel: string;
  /** Material Symbols name of the row tile (key, computer, receipt_long, support_agent). */
  icon: "key" | "computer" | "receipt_long" | "support_agent";
  id: string;
  title: string;
  sub: string;
  /** Portal path, or the order page (/orders/:id, a full page load). */
  href: string;
};

export type SearchResponse = { q: string; results: SearchResult[] };

const TYPE_META: Record<SearchResultType, Pick<SearchResult, "typeLabel" | "icon">> = {
  license: { typeLabel: "LICENSE", icon: "key" },
  device: { typeLabel: "DEVICE", icon: "computer" },
  order: { typeLabel: "ORDER", icon: "receipt_long" },
  ticket: { typeLabel: "TICKET", icon: "support_agent" },
};

const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

function result(type: SearchResultType, fields: Omit<SearchResult, "type" | "typeLabel" | "icon">): SearchResult {
  return { type, ...TYPE_META[type], ...fields };
}

/** Keyed hash of a pasted full key, or null when the text is not a key (never logged). */
function pastedKeyHash(q: string): string | null {
  const normalized = normalizeLicenseKey(q);
  if (!isLicenseKeyFormat(normalized)) return null;
  return hashLicenseKey(normalized, getLicenseKeySecrets().pepper);
}

function licenseWhere(accountId: string, q: string): Prisma.LicenseWhereInput {
  const or: Prisma.LicenseWhereInput[] = [
    { id: contains(q) },
    { product: { name: contains(q) } },
    { product: { shortName: contains(q) } },
  ];
  const compact = q.replace(/[\s-]/g, "").toUpperCase();
  if (compact.length >= SEARCH_MIN_LENGTH && compact.length <= 4) or.push({ keyLast4: { contains: compact } });
  const keyHash = pastedKeyHash(q);
  if (keyHash) or.push({ keyHash });
  return { accountId, OR: or };
}

/** GET /api/account/search?q=: grouped matches for the active account; [] below SEARCH_MIN_LENGTH characters. */
export async function searchAccount(client: Db, accountId: string, rawQuery: string): Promise<SearchResponse> {
  const q = rawQuery.trim();
  if (q.length < SEARCH_MIN_LENGTH) return { q, results: [] };

  const licenses = await client.license.findMany({
    where: licenseWhere(accountId, q),
    orderBy: { id: "asc" },
    take: SEARCH_PER_TYPE,
    select: {
      id: true,
      keyLast4: true,
      product: { select: { code: true, shortName: true } },
      plan: { select: { name: true } },
    },
  });
  const devices = await client.deviceActivation.findMany({
    where: { license: { accountId }, name: contains(q) },
    orderBy: [{ deactivatedAt: { sort: "desc", nulls: "first" } }, { lastSeenAt: "desc" }, { id: "asc" }],
    take: SEARCH_PER_TYPE,
    select: { id: true, name: true, os: true, deactivatedAt: true, licenseId: true },
  });
  const orders = await client.order.findMany({
    where: { accountId, OR: [{ id: contains(q) }, { invoice: { is: { number: contains(q) } } }] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SEARCH_PER_TYPE,
    select: { id: true, totalPaise: true, invoice: { select: { number: true } } },
  });
  const tickets = await client.supportTicket.findMany({
    where: { accountId, OR: [{ id: contains(q) }, { subject: contains(q) }] },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: SEARCH_PER_TYPE,
    select: { id: true, subject: true },
  });

  const results: SearchResult[] = [
    ...licenses.map((l) =>
      result("license", {
        id: l.id,
        title: `${l.id} \u00b7 ${l.product.shortName}`,
        sub: `${l.plan.name} \u00b7 ${maskLicenseKey(l.product.code, l.keyLast4)}`,
        href: `/account/licenses/${encodeURIComponent(l.id)}`,
      }),
    ),
    ...devices.map((d) =>
      result("device", {
        id: d.id,
        title: d.name,
        sub: `${d.licenseId} \u00b7 ${d.os}${d.deactivatedAt ? " \u00b7 deactivated" : ""}`,
        href: `/account/licenses/${encodeURIComponent(d.licenseId)}?tab=devices`,
      }),
    ),
    ...orders.map((o) =>
      result("order", {
        id: o.id,
        title: o.id,
        sub: `${o.invoice?.number ?? "No invoice"} \u00b7 ${formatINR(o.totalPaise)}`,
        href: `/orders/${encodeURIComponent(o.id)}`,
      }),
    ),
    ...tickets.map((t) =>
      result("ticket", { id: t.id, title: t.id, sub: t.subject, href: `/account/tickets/${encodeURIComponent(t.id)}` }),
    ),
  ];
  return { q, results: results.slice(0, SEARCH_LIMIT) };
}
