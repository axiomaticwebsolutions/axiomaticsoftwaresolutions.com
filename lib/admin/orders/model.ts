/**
 * Admin Orders, payments & refunds (Admin Console.dc.html #orders; decisions.md Phase 6). Pure and client-safe:
 * list state, filter vocabulary, the DTOs the API returns and the formatting both the server and the console use.
 *
 * URL and API share one shape: /admin/orders?q=&filter[status]=paid&filter[date]=30d&sort=-createdAt&page=2 and
 * GET /api/admin/orders?<same> -> { items, total, page, pageSize }. Amounts are integer paise, dates ISO strings.
 */
import { formatDateIST, istParts, MONTHS_SHORT } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { PAYMENT_PROVIDER_KEYS, type PaymentProviderKey } from "@/lib/payments/types";
import { defineListState, listStateToParams, type ListState } from "@/lib/url-state";

export const ADMIN_ORDERS_PATH = "/admin/orders";
export const ADMIN_ORDERS_API = "/api/admin/orders";
export const ADMIN_ORDERS_PAGE_SIZE = 25;
export const ADMIN_ORDERS_SEARCH_MAX = 100;
/** Most ids one bulk request (resend invoices, export selected) may carry. */
export const ADMIN_ORDERS_BULK_MAX = 100;

// ---------- Filters ----------

/** Status filter values (lower-case OrderStatus), in the prototype's select order plus "Partly refunded". */
export const ORDER_STATUS_FILTERS = [
  "paid",
  "pending",
  "failed",
  "refunded",
  "partially_refunded",
  "canceled",
  "awaiting_payment",
  "confirming",
  "review",
] as const;
export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number];

export const ORDER_STATUS_FILTER_LABELS: Record<OrderStatusFilter, string> = {
  paid: "Paid",
  pending: "Pending",
  failed: "Failed",
  refunded: "Refunded",
  partially_refunded: "Partly refunded",
  canceled: "Canceled",
  awaiting_payment: "Awaiting payment",
  confirming: "Confirming",
  review: "In review",
};

/** Payment.method values (display labels; no instrument details are stored) and their URL values. */
export const ORDER_METHOD_FILTERS = ["upi", "card", "netbanking"] as const;
export type OrderMethodFilter = (typeof ORDER_METHOD_FILTERS)[number];
export const ORDER_METHOD_LABELS: Record<OrderMethodFilter, string> = { upi: "UPI", card: "Card", netbanking: "Net banking" };

/** Date range presets (created in the last N days, IST "today"). The API also takes filter[from] / filter[to]. */
export const ORDER_DATE_FILTERS = ["today", "7d", "30d", "90d", "12m"] as const;
export type OrderDateFilter = (typeof ORDER_DATE_FILTERS)[number];
export const ORDER_DATE_LABELS: Record<OrderDateFilter, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "12m": "Last 12 months",
};

/** Coupon filter: any coupon, no coupon, or one code. */
export const COUPON_FILTER_ANY = "any";
export const COUPON_FILTER_NONE = "none";
export const COUPON_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

export const ORDER_PROVIDER_FILTERS = PAYMENT_PROVIDER_KEYS;
export const PROVIDER_LABELS: Record<PaymentProviderKey, string> = { razorpay: "Razorpay", cashfree: "Cashfree", mock: "Mock" };

/** Sortable columns (column ids of the table and `sort` values of the API). */
export const ORDER_SORTS = ["createdAt", "id", "customer", "status", "totalPaise"] as const;
export type OrderSort = (typeof ORDER_SORTS)[number];

export type OrderFilterKey = "status" | "method" | "product" | "date" | "coupon" | "provider";

/** URL state of /admin/orders (bracket filters like the API). Module constant: it is a hook dependency. */
export const ADMIN_ORDERS_LIST = defineListState<OrderFilterKey>({
  filterStyle: "bracket",
  filters: {
    status: { values: ORDER_STATUS_FILTERS },
    method: { values: ORDER_METHOD_FILTERS },
    product: {},
    date: { values: ORDER_DATE_FILTERS },
    coupon: {},
    provider: { values: ORDER_PROVIDER_FILTERS },
  },
  sortable: ORDER_SORTS,
  defaultSort: { id: "createdAt", desc: true },
  pageSize: ADMIN_ORDERS_PAGE_SIZE,
  maxQueryLength: ADMIN_ORDERS_SEARCH_MAX,
});

export type AdminOrdersListState = ListState<OrderFilterKey>;

/** Normalises a coupon filter value: "any", "none" or an upper-case code; null when invalid. */
export function parseCouponFilter(raw: string): string | null {
  const value = raw.trim();
  if (value === COUPON_FILTER_ANY || value === COUPON_FILTER_NONE) return value;
  const code = value.toUpperCase();
  return COUPON_CODE_RE.test(code) ? code : null;
}

/** Product ids are slugs / cuids. */
export function parseProductFilter(raw: string): string | null {
  const value = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ? value : null;
}

/** "2026-10-07" (IST calendar day) or null. */
export function parseDayFilter(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? raw.trim() : null;
}

// ---------- Query ----------

/** The list/export query after parsing (URL state on the page, parseListQuery in the API). */
export type AdminOrderFilters = {
  status?: OrderStatusFilter;
  method?: OrderMethodFilter;
  product?: string;
  date?: OrderDateFilter;
  /** IST calendar days, inclusive (API only). */
  from?: string;
  to?: string;
  coupon?: string;
  provider?: PaymentProviderKey;
  /** Export selected rows (API only). */
  ids?: readonly string[];
};

export type AdminOrderQuery = {
  q: string;
  filters: AdminOrderFilters;
  sort: { id: OrderSort; desc: boolean };
  page: number;
  pageSize: number;
};

function isOneOf<T extends string>(values: readonly T[], value: string | undefined): value is T {
  return value !== undefined && (values as readonly string[]).includes(value);
}

/** The service query for the page's URL state (invalid values were already dropped by parseListState). */
export function orderQueryFromState(state: AdminOrdersListState): AdminOrderQuery {
  const f = state.filters;
  const filters: AdminOrderFilters = {};
  if (isOneOf(ORDER_STATUS_FILTERS, f.status)) filters.status = f.status;
  if (isOneOf(ORDER_METHOD_FILTERS, f.method)) filters.method = f.method;
  if (isOneOf(ORDER_DATE_FILTERS, f.date)) filters.date = f.date;
  if (isOneOf(ORDER_PROVIDER_FILTERS, f.provider)) filters.provider = f.provider;
  const product = f.product && f.product !== "all" ? parseProductFilter(f.product) : null;
  if (product) filters.product = product;
  const coupon = f.coupon && f.coupon !== "all" ? parseCouponFilter(f.coupon) : null;
  if (coupon) filters.coupon = coupon;
  const sortId = state.sort && isOneOf(ORDER_SORTS, state.sort.id) ? state.sort.id : "createdAt";
  return {
    q: state.q,
    filters,
    sort: { id: sortId, desc: state.sort && sortId === state.sort.id ? state.sort.desc : true },
    page: state.page,
    pageSize: state.pageSize,
  };
}

/** Server CSV export for the current filters (or the selected ids), e.g. "/api/admin/orders/export.csv?filter[status]=paid". */
export function ordersExportHref(state: AdminOrdersListState, ids?: readonly string[]): string {
  const params = listStateToParams({ ...state, page: 1 }, ADMIN_ORDERS_LIST);
  params.delete("page");
  if (ids && ids.length > 0) params.set("ids", ids.join(","));
  const query = params.toString();
  return `${ADMIN_ORDERS_API}/export.csv${query ? `?${query}` : ""}`;
}

export const orderApiPath = (id: string) => `${ADMIN_ORDERS_API}/${encodeURIComponent(id)}`;
export const orderRefundPath = (id: string) => `${orderApiPath(id)}/refund`;
export const orderResendPath = (id: string) => `${orderApiPath(id)}/resend-invoice`;
export const orderReviewPath = (id: string) => `${orderApiPath(id)}/review`;
export const orderInvoicePdfPath = (id: string) => `${orderApiPath(id)}/invoice.pdf`;
export const ORDERS_RESEND_BULK_PATH = `${ADMIN_ORDERS_API}/resend-invoices`;
export const webhookReplayPath = (eventId: string) => `/api/admin/webhooks/${encodeURIComponent(eventId)}/replay`;

// ---------- DTOs ----------

/** Lower-case OrderStatus as the API returns it ("paid", "partially_refunded", "review"). */
export type OrderStatusValue = OrderStatusFilter;

export type AdminOrderRow = {
  id: string;
  createdAt: string;
  invoiceNumber: string | null;
  /** Business, else account name, else the billing name, else the email. */
  customer: string;
  email: string;
  /** "Medical Store Billing · One-time license", lines joined with ", " (" ×2" for quantities above one). */
  items: string;
  status: OrderStatusValue;
  /** Latest payment attempt's method ("UPI", "Card", "Net banking"). */
  method: string | null;
  provider: string | null;
  couponCode: string | null;
  totalPaise: number;
  /** "IGST", "CGST+SGST" or null without GST. */
  taxLabel: string | null;
};

export type AdminOrderList = { items: AdminOrderRow[]; total: number; page: number; pageSize: number };

export type AdminOrderStats = { paid: number; pending: number; failed: number; refundedPaise: number };

export type AdminOrderFilterOptions = {
  products: { value: string; label: string }[];
  coupons: string[];
  providers: PaymentProviderKey[];
};

export type AdminOrderItem = {
  id: string;
  product: string;
  plan: string;
  kind: "NEW" | "RENEWAL" | "UPGRADE" | "ADDON";
  quantity: number;
  /** unit price x quantity (excluding GST, before discount), as the prototype lists it. */
  linePaise: number;
  issuedLicenseId: string | null;
  targetLicenseId: string | null;
  fulfilled: boolean;
};

export type AdminOrderPayment = {
  id: string;
  provider: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  method: string | null;
  status: string;
  amountPaise: number;
  createdAt: string;
  capturedAt: string | null;
  failureReason: string | null;
  /**
   * A captured payment that did not pay the order (a second capture, or a capture of an order that was never
   * fulfilled). "Refund duplicate payment" (refunds.issue; POST .../refund with `paymentId`) returns it on its own.
   */
  duplicate: boolean;
  /** What "Refund duplicate payment" returns now (0 when it is not a duplicate or nothing is left). */
  refundablePaise: number;
};

export type AdminOrderRefund = {
  id: string;
  amountPaise: number;
  reason: string;
  creditNoteNo: string | null;
  status: string;
  createdAt: string;
  processedAt: string | null;
  createdBy: string | null;
  providerRefundId: string | null;
};

export type AdminOrderWebhook = {
  /** WebhookDelivery id. */
  id: string;
  provider: string;
  eventId: string | null;
  type: string | null;
  result: string;
  receivedAt: string;
  signatureOk: boolean;
  replayedBy: string | null;
  /** A stored, signature-valid event exists for this delivery, so it can be replayed. */
  replayable: boolean;
};

export type AdminOrderLicense = { id: string; product: string; maskedKey: string; status: string };

export type AdminOrderHistoryEntry = { id: string; action: string; actor: string; reason: string | null; detail: string | null; at: string };

export type AdminOrderRefundState = {
  /** A refund can be issued now (status, captured payment, amount left). */
  allowed: boolean;
  /** Full refund amount: the paying payment minus refunds already issued. */
  amountPaise: number;
  /** Licenses this order issued that are still not revoked (the confirm copy). */
  licenseCount: number;
  /** Renewal, add-on and upgrade lines a full refund reverses. */
  changeCount: number;
};

export type AdminOrderDetail = {
  id: string;
  status: OrderStatusValue;
  createdAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  email: string;
  failReason: string | null;
  customer: string;
  accountId: string | null;
  billing: { name: string; business: string | null; address: string; city: string; state: string; pin: string; phone: string };
  gstin: string | null;
  placeOfSupply: string;
  couponCode: string | null;
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  invoice: { number: string; issuedAt: string } | null;
  items: AdminOrderItem[];
  payments: AdminOrderPayment[];
  refunds: AdminOrderRefund[];
  webhooks: AdminOrderWebhook[];
  licenses: AdminOrderLicense[];
  history: AdminOrderHistoryEntry[];
  refund: AdminOrderRefundState;
};

// ---------- Formatting ----------

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "7:22 am" (IST, prototype lower-case 12-hour time). */
export function formatTimeIST(value: string | Date): string {
  const p = istParts(typeof value === "string" ? new Date(value) : value);
  const hour = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${hour}:${pad2(p.minute)} ${p.hour < 12 ? "am" : "pm"}`;
}

/** "4 Oct, 7:10 am" (drawer lines). */
export function formatShortDateTimeIST(value: string | Date | null | undefined, fallback = "\u2014"): string {
  if (!value) return fallback;
  const d = typeof value === "string" ? new Date(value) : value;
  const p = istParts(d);
  return `${p.day} ${MONTHS_SHORT[p.month - 1] ?? ""}, ${formatTimeIST(d)}`;
}

/** "7 Oct 2026" */
export function formatOrderDate(value: string | Date): string {
  return formatDateIST(typeof value === "string" ? new Date(value) : value);
}

/** Exact rupees ("₹15,338.82"). */
export const money = (paise: number) => formatINR(paise, { exact: true });

/** Whole rupees for the stats row ("₹31,441"). */
export const moneyRounded = (paise: number) => formatINR(Math.round(paise / 100) * 100);

/** "IGST", "CGST+SGST" or null (no GST on the order). */
export function taxLabel(o: { cgstPaise: number; sgstPaise: number; igstPaise: number }): string | null {
  if (o.igstPaise > 0) return "IGST";
  if (o.cgstPaise > 0 || o.sgstPaise > 0) return "CGST+SGST";
  return null;
}

/** "IGST ₹2,339.82" or "CGST ₹449.91 + SGST ₹449.91" (drawer GST field). */
export function gstSplitLabel(o: { cgstPaise: number; sgstPaise: number; igstPaise: number }): string {
  if (o.igstPaise > 0) return `IGST ${money(o.igstPaise)}`;
  if (o.cgstPaise > 0 || o.sgstPaise > 0) return `CGST ${money(o.cgstPaise)} + SGST ${money(o.sgstPaise)}`;
  return money(0);
}

/** "−₹500.00 (DIWALI10)" or null. */
export function discountLabel(discountPaise: number, couponCode: string | null): string | null {
  if (discountPaise <= 0) return null;
  return `\u2212${money(discountPaise)}${couponCode ? ` (${couponCode})` : ""}`;
}

/** "Medical Store Billing · One-time license" plus " ×3" above one. */
export function itemLabel(product: string, plan: string, quantity: number): string {
  return `${product} \u00B7 ${plan}${quantity > 1 ? ` \u00D7${quantity}` : ""}`;
}

/** "Razorpay", "Razorpay (test)", "Mock (test)". */
export function providerLabel(provider: string, testMode: boolean): string {
  const name = (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;
  return provider === "mock" || testMode ? `${name} (test)` : name;
}

export type RowTone = "sage" | "pink" | "peach" | "muted";

/** Payments section status colour: captured green, failed red, else grey (prototype). */
export function paymentTone(status: string): RowTone {
  const s = status.toLowerCase();
  if (s === "captured") return "sage";
  if (s === "failed") return "pink";
  return "muted";
}

/** Webhook result colour: applied green, rejected or flagged red, everything else grey. */
export function webhookTone(result: string): RowTone {
  if (result === "fulfilled" || result === "refund_processed") return "sage";
  if (result === "invalid_signature" || result === "amount_mismatch" || result === "fulfilment_failed" || result === "refund_failed") return "pink";
  return "muted";
}

/** Refund rows: processed green, failed red, pending peach. */
export function refundTone(status: string): RowTone {
  const s = status.toLowerCase();
  if (s === "processed") return "sage";
  if (s === "failed") return "pink";
  return "peach";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Refund dialog title (prototype): "Refund ₹15,338.82 for AX-10294?" */
export function refundTitle(amountPaise: number, orderId: string): string {
  return `Refund ${money(amountPaise)} for ${orderId}?`;
}

/** Refund dialog body (prototype copy, plus the renewal/add-on reversal sentence when it applies). */
export function refundConsequence(state: Pick<AdminOrderRefundState, "licenseCount" | "changeCount">): string {
  const revokes =
    state.licenseCount > 0 ? ` and revokes ${plural(state.licenseCount, "license")} issued by this order` : "";
  const reverses =
    state.changeCount > 0
      ? ` Renewals, add-ons and upgrades bought in this order are reversed when the license hasn\u2019t changed since; otherwise the order is flagged for review.`
      : "";
  return `Sends a full refund through the payment provider${revokes}. A credit note is generated.${reverses}`;
}

export type RefundResponse = {
  refund: { id: string; amountPaise: number; creditNoteNo: string | null; status: string };
  revokedLicenseIds: string[];
  reversedLicenseIds: string[];
  /** Changes that could not be reversed: the order went to REVIEW. */
  review: boolean;
  orderStatus: OrderStatusValue;
  /** A duplicate payment was refunded (no credit note, no license change, order status unchanged). */
  duplicate: boolean;
};

/** Toast after a refund (prototype "Refund issued · licenses revoked"). */
export function refundToast(result: Pick<RefundResponse, "revokedLicenseIds" | "reversedLicenseIds" | "review"> & { duplicate?: boolean }): string {
  if (result.duplicate) return "Duplicate payment refunded";
  if (result.review) return "Refund issued \u00B7 order flagged for review";
  if (result.revokedLicenseIds.length > 0) return "Refund issued \u00B7 licenses revoked";
  if (result.reversedLicenseIds.length > 0) return "Refund issued \u00B7 license changes reversed";
  return "Refund issued";
}

export type ReplayResponse = { eventId: string; provider: string; result: string };

/** Prototype: "Replayed evt_7Qm2pX → duplicate_ignored (idempotent, nothing re-issued)". */
export function replayToast(result: ReplayResponse): string {
  const note = result.result === "duplicate_ignored" ? " (idempotent, nothing re-issued)" : "";
  return `Replayed ${result.eventId} \u2192 ${result.result}${note}`;
}

export type ResendResponse = { queued: string[]; skipped: { id: string; reason: string }[] };

/** "2 invoice emails queued" (+ " · 1 skipped"). */
export function resendToast(result: ResendResponse): string {
  const queued = result.queued.length;
  const head = queued === 0 ? "No invoice emails queued" : `${plural(queued, "invoice email")} queued`;
  return result.skipped.length > 0 ? `${head} \u00B7 ${result.skipped.length} skipped` : head;
}

/** Copy (prototype unless noted). */
export const ORDERS_COPY = {
  searchPlaceholder: "Search order ID, invoice, email or payment ID",
  searchLabel: "Search orders",
  caption: "Orders",
  csvFileName: "orders.csv",
  selectedCsvFileName: "orders-selected.csv",
  /** New copy. */
  loadError: "We couldn\u2019t load orders. Try again in a moment.",
  /** New copy. */
  detailError: "We couldn\u2019t load this order.",
  emptyNone: "No orders yet.",
  webhooksEmpty: "No webhook events recorded for this order.",
  licensesEmpty: "No licenses \u2014 issued only after payment is confirmed.",
  /** New copy. */
  paymentsEmpty: "No payment attempts yet.",
  /** New copy. */
  refundsEmpty: "No refunds.",
  /** New copy. */
  historyEmpty: "No staff or system actions recorded yet.",
  /** New copy: View invoice before payment. */
  invoiceUnavailable: "The invoice is issued after the payment is confirmed.",
  /** New copy. */
  reviewTitle: "This order needs a review",
  /** New copy. */
  markReviewed: "Mark reviewed",
  /** New copy. */
  markReviewedBody:
    "Closes the review and returns the order to the status its payments and refunds show. Your reason is saved to the audit log.",
  /** New copy. */
  markReviewedDone: "Review closed",
  resendInvoice: "Resend invoice",
  resendInvoices: "Resend invoices",
  exportSelected: "Export selected",
  viewInvoice: "View invoice",
  unregistered: "Unregistered",
  notIssued: "Not issued",
} as const;

/** Drawer item line (prototype detail: " × 2" with spaces). */
export function drawerItemLabel(product: string, plan: string, quantity: number): string {
  return `${product} \u00B7 ${plan}${quantity > 1 ? ` \u00D7 ${quantity}` : ""}`;
}

/** Item kind as the drawer shows it when no license was issued ("Renewal of LIC-24017"). */
export function itemKindLabel(kind: AdminOrderItem["kind"], targetLicenseId: string | null): string {
  const target = targetLicenseId ? ` of ${targetLicenseId}` : "";
  switch (kind) {
    case "RENEWAL":
      return `Renewal${target}`;
    case "ADDON":
      return `Add-on for ${targetLicenseId ?? "a license"}`;
    case "UPGRADE":
      return `Upgrade${target}`;
    case "NEW":
      return "New";
  }
}

/** "Exported 12 rows · orders.csv" (prototype CSV toast). */
export function exportToast(rows: number, fileName: string, truncated: boolean): string {
  return `Exported ${rows} ${rows === 1 ? "row" : "rows"} \u00B7 ${fileName}${truncated ? " (first 10,000 rows)" : ""}`;
}
