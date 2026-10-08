/**
 * Prisma `where` / `orderBy` for the admin order list and export (pure: no database access, unit-tested).
 *
 * Search classifies the term first so the common lookups use an index at scale: an order id ("AX-10294") is an id
 * prefix, an invoice number an exact match (also an invoice a billing correction cancelled, or its credit note), a provider id ("pay_...", "order_...") an exact match on Payment, a GSTIN
 * an exact JSON match, an email a case-insensitive match on Order.email. Anything else searches id, email, business,
 * billing name, account name, GSTIN and invoice number (case-insensitive contains).
 */
import type { OrderStatus, Prisma } from "@/generated/prisma/client";
import { addCalendarMonths, endOfDayIST, startOfDayIST } from "@/lib/dates";
import { toPrismaOrderBy } from "@/lib/admin/list-query";
import {
  COUPON_FILTER_ANY,
  COUPON_FILTER_NONE,
  ORDER_METHOD_LABELS,
  type AdminOrderFilters,
  type AdminOrderQuery,
  type OrderDateFilter,
} from "./model";

const ORDER_ID_RE = /^AX-\d{1,12}$/i;
const DOCUMENT_NO_RE = /^[A-Z0-9-]{1,3}\/\d{2}-\d{2}\/\d{1,7}$/i;
const PROVIDER_ID_RE = /^(pay|order|evt|rfnd)_[A-Za-z0-9_]{3,120}$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

type Where = Prisma.OrderWhereInput;

/** The search condition for `q`, or undefined without a search. */
export function orderSearchWhere(q: string): Where | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const upper = term.toUpperCase();
  if (ORDER_ID_RE.test(term)) return { id: { startsWith: upper } };
  if (DOCUMENT_NO_RE.test(term)) {
    return {
      OR: [
        { invoice: { is: { number: upper } } },
        { invoiceCorrections: { some: { OR: [{ originalInvoiceNo: upper }, { creditNoteNo: upper }] } } },
      ],
    };
  }
  if (PROVIDER_ID_RE.test(term)) {
    return { payments: { some: { OR: [{ providerPaymentId: term }, { providerOrderId: term }] } } };
  }
  if (GSTIN_RE.test(upper)) return { billing: { path: ["gstin"], equals: upper } };
  if (term.includes("@")) return { email: { contains: term, mode: "insensitive" } };
  return {
    OR: [
      { id: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
      { billing: { path: ["business"], string_contains: term, mode: "insensitive" } },
      { billing: { path: ["name"], string_contains: term, mode: "insensitive" } },
      { billing: { path: ["gstin"], string_contains: upper } },
      { account: { is: { legalName: { contains: term, mode: "insensitive" } } } },
      { invoice: { is: { number: { contains: upper } } } },
      { invoiceCorrections: { some: { originalInvoiceNo: { contains: upper } } } },
    ],
  };
}

/** Lower bound of a date preset (IST "today" starts at midnight IST). */
export function dateRangeStart(preset: OrderDateFilter, now: Date): Date {
  switch (preset) {
    case "today":
      return startOfDayIST(now);
    case "7d":
      return new Date(now.getTime() - 7 * 86_400_000);
    case "30d":
      return new Date(now.getTime() - 30 * 86_400_000);
    case "90d":
      return new Date(now.getTime() - 90 * 86_400_000);
    case "12m":
      return addCalendarMonths(now, -12);
  }
}

/** Every filter as one AND list (search included). */
export function orderWhere(q: string, filters: AdminOrderFilters, now: Date = new Date()): Where {
  const and: Where[] = [];
  const search = orderSearchWhere(q);
  if (search) and.push(search);
  if (filters.ids && filters.ids.length > 0) and.push({ id: { in: [...filters.ids] } });
  if (filters.status) and.push({ status: filters.status.toUpperCase() as OrderStatus });
  if (filters.method) and.push({ payments: { some: { method: ORDER_METHOD_LABELS[filters.method] } } });
  if (filters.provider) and.push({ payments: { some: { provider: filters.provider } } });
  if (filters.product) and.push({ items: { some: { plan: { productId: filters.product } } } });
  if (filters.coupon === COUPON_FILTER_ANY) and.push({ couponCode: { not: null } });
  else if (filters.coupon === COUPON_FILTER_NONE) and.push({ couponCode: null });
  else if (filters.coupon) and.push({ couponCode: filters.coupon });
  const created: Prisma.DateTimeFilter = {};
  if (filters.date) created.gte = dateRangeStart(filters.date, now);
  if (filters.from) {
    const from = startOfDayIST(filters.from);
    if (!created.gte || from > (created.gte as Date)) created.gte = from;
  }
  if (filters.to) created.lte = endOfDayIST(filters.to);
  if (created.gte || created.lte) and.push({ createdAt: created });
  return and.length === 0 ? {} : { AND: and };
}

/**
 * Sort: "createdAt" and "id" both follow creation time (ids are allocated in order, and their string order breaks
 * past AX-99999); "customer" sorts by account name (guest orders last), then email.
 */
export function orderOrderBy(sort: AdminOrderQuery["sort"]): Prisma.OrderOrderByWithRelationInput[] {
  return toPrismaOrderBy<Prisma.OrderOrderByWithRelationInput>(sort, {
    createdAt: "createdAt",
    id: "createdAt",
    customer: (dir) => [{ account: { legalName: dir } }, { email: dir }],
    status: "status",
    totalPaise: "totalPaise",
  });
}
