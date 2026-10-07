/**
 * Orders & invoices view model (Customer Portal.dc.html "Orders" view; decisions.md Phase 5 "Orders"). Pure and
 * client-safe: the server page parses the URL with ORDERS_LIST and queries lib/portal/orders; the client table writes
 * the same state back to the URL (?q=&status=&sort=&page=, defaults left out) and builds the accountant export URL.
 *
 * Rows come from lib/portal/orders (AccountOrderRow): amounts are the order snapshot in paise, dates ISO strings.
 */
import type { IconName } from "@/components/icons/icon";
import { orderPath } from "@/components/account/portal-nav";
import type { AccountOrderList, AccountOrderRow } from "@/lib/portal/orders";
import { formatDateIST } from "@/lib/dates";
import { invoiceFileName } from "@/lib/invoice/model";
import { formatINR } from "@/lib/money";
import { defineListState, listStateToParams, type ListState } from "@/lib/url-state";
import { SEARCH_MAX } from "@/lib/validation/license-actions";
import {
  ORDER_SORT_KEYS,
  ORDER_STATUS_FILTER_LABELS,
  ORDER_STATUS_FILTERS,
  ORDERS_PAGE_SIZE,
  type OrderListQuery,
  type OrderSortKey,
  type OrderStatusFilter,
} from "@/lib/validation/portal";

export type { AccountOrderList, AccountOrderRow };

/** GET /api/account/orders/export.csv (F3): every order matching ?q=&status=&sort=, GST split, IST dates. */
export const ORDERS_EXPORT_PATH = "/api/account/orders/export.csv";
export const ORDERS_CSV_FALLBACK_NAME = "orders.csv";

/** Copy from the prototype unless marked new. */
export const ORDERS_COPY = {
  title: "Orders & invoices",
  exportAction: "Export for accountant",
  searchPlaceholder: "Order or invoice number",
  searchLabel: "Search orders",
  statusLabel: "Status",
  caption: "Orders",
  paginationLabel: "Orders pages",
  empty: "No orders match.",
  /** New copy: an account without any order (the prototype only has the filtered empty state). */
  emptyNone: "No orders yet.",
  /** New copy. */
  browse: "Browse software",
  /** New copy (prototype licenses table). */
  clearFilters: "Clear filters",
  emptyLabel: "0 orders",
  invoice: "Invoice",
  view: "View",
  /** New copy: the list could not be loaded. */
  loadError: "We couldn’t load your orders.",
  retry: "Try again",
  /** New copy: export failed without a server message. */
  exportFailed: "Couldn’t export. Try again.",
  /** New copy: invoice download failed without a server message. */
  invoiceFailed: "Couldn’t download the invoice. Try again.",
  actionsHeader: "Actions",
} as const;

/** URL list state of the Orders page; shared by the server page and the client table (module constant). */
export const ORDERS_LIST = defineListState({
  filters: { status: { values: ORDER_STATUS_FILTERS.filter((s) => s !== "all") } },
  sortable: ORDER_SORT_KEYS,
  defaultSort: { id: "date", desc: true },
  pageSize: ORDERS_PAGE_SIZE,
  maxQueryLength: SEARCH_MAX,
});

export type OrdersListState = ListState<"status">;

/** Status select options in the prototype order: All, Paid, Refunded, Pending, Failed, Canceled. */
export const ORDER_STATUS_OPTIONS: readonly { value: OrderStatusFilter; label: string }[] = ORDER_STATUS_FILTERS.map((value) => ({
  value,
  label: ORDER_STATUS_FILTER_LABELS[value],
}));

function isStatusFilter(value: string): value is OrderStatusFilter {
  return (ORDER_STATUS_FILTERS as readonly string[]).includes(value);
}

function isSortKey(value: string): value is OrderSortKey {
  return (ORDER_SORT_KEYS as readonly string[]).includes(value);
}

/** List state -> the query lib/portal/orders runs (same shape as parseOrderListQuery; invalid values -> defaults). */
export function orderListQuery(state: OrdersListState): OrderListQuery {
  const sort = state.sort && isSortKey(state.sort.id) ? state.sort : { id: "date", desc: true };
  return {
    q: state.q,
    status: isStatusFilter(state.filters.status) ? state.filters.status : "all",
    sort: { key: sort.id as OrderSortKey, dir: sort.desc ? -1 : 1 },
    page: state.page,
  };
}

/** The accountant export for the current search, status and sort (all pages). */
export function ordersExportHref(state: OrdersListState): string {
  const query = listStateToParams({ ...state, page: 1 }, ORDERS_LIST).toString();
  return query ? `${ORDERS_EXPORT_PATH}?${query}` : ORDERS_EXPORT_PATH;
}

/**
 * Page description. The guest-checkout clause only shows when guest orders placed with the member's email are
 * claimed into THIS account (decisions.md rule 1: the member's first Owner account); otherwise it would be untrue.
 */
export function ordersDescription(guestCheckoutEmail: string | null): string {
  return guestCheckoutEmail
    ? `All purchases for this business, including guest checkouts with ${guestCheckoutEmail}. Export for your accountant.`
    : "All purchases for this business. Export for your accountant.";
}

/** "17 Sep 2026" (IST). */
export function orderDateLabel(row: Pick<AccountOrderRow, "createdAt">): string {
  return formatDateIST(new Date(row.createdAt));
}

/** "₹4,128.82" (orders always show paise, as in the prototype). */
export function orderTotalLabel(row: Pick<AccountOrderRow, "totalPaise">): string {
  return formatINR(row.totalPaise, { exact: true });
}

/** "incl. ₹629.82 GST" */
export function orderTaxLabel(row: Pick<AccountOrderRow, "taxPaise">): string {
  return `incl. ${formatINR(row.taxPaise, { exact: true })} GST`;
}

/** "AXS/26-27/1166" or an em dash. */
export function orderInvoiceLabel(row: Pick<AccountOrderRow, "invoiceNumber">): string {
  return row.invoiceNumber ?? "—";
}

export function orderHref(row: Pick<AccountOrderRow, "id">): string {
  return orderPath(row.id);
}

export type OrderRowAction =
  | { kind: "invoice"; label: string; icon: IconName; href: string; ariaLabel: string; fileName: string }
  | { kind: "view"; label: string; icon: IconName; href: string; ariaLabel: string };

/**
 * The row button: "Invoice" downloads the tax invoice PDF once the order has one (decisions.md Phase 5); otherwise
 * "View" opens the order page (a full page load, decisions.md Phase 3 CSP).
 */
export function orderRowAction(row: Pick<AccountOrderRow, "id" | "invoiceNumber" | "invoicePdfHref">): OrderRowAction {
  if (row.invoiceNumber && row.invoicePdfHref) {
    return {
      kind: "invoice",
      label: ORDERS_COPY.invoice,
      icon: "description",
      href: row.invoicePdfHref,
      ariaLabel: `Download invoice ${row.invoiceNumber}`,
      fileName: invoiceFileName(row.invoiceNumber),
    };
  }
  return { kind: "view", label: ORDERS_COPY.view, icon: "open_in_new", href: orderPath(row.id), ariaLabel: `View order ${row.id}` };
}

/** "Exported 12 rows to orders.csv" (prototype); a cut export adds how to get the rest (new copy). */
export function exportToastMessage(rows: number, fileName: string, truncated = false): string {
  const n = rows.toLocaleString("en-IN");
  const base = `Exported ${n} ${rows === 1 ? "row" : "rows"} to ${fileName}`;
  return truncated ? `${base}. Narrow the filters to export the rest.` : base;
}

/** Reads X-Export-Rows / X-Export-Truncated of the export response (null when missing or malformed). */
export function exportResult(headers: { get(name: string): string | null }): { rows: number | null; truncated: boolean } {
  const raw = headers.get("x-export-rows");
  const rows = raw !== null && /^[0-9]{1,9}$/.test(raw) ? Number(raw) : null;
  return { rows, truncated: headers.get("x-export-truncated") === "1" };
}
