/**
 * Support tickets list state in the URL (decisions.md Phase 5: filters, sort and paging live in the URL):
 *
 *   /account/tickets?q=scanner&status=awaiting_customer&product=medical-billing&sort=-priority&page=2
 *
 * The server page parses it with parseListState(searchParams, TICKETS_LIST) and turns it into the query of
 * lib/portal/tickets listTickets(); the client table writes it with useListState(TICKETS_LIST). Defaults (All
 * statuses, all products, most recently updated first, page 1) are left out of the URL. Pure and client-safe.
 */
import { defineListState, type ListState } from "@/lib/url-state";
import {
  TICKET_STATUS_FILTER_LABELS,
  TICKET_STATUS_FILTERS,
  TICKETS_PAGE_SIZE,
  type TicketListQuery,
  type TicketSortKey,
  type TicketStatusFilter,
} from "@/lib/validation/tickets";

/** Sortable columns of the tickets table (ids match the table's column ids and the API's sort keys). */
export const TICKET_TABLE_SORTS = ["created", "priority", "status", "updated"] as const satisfies readonly TicketSortKey[];

export const TICKETS_LIST = defineListState<"status" | "product">({
  filters: {
    status: { values: TICKET_STATUS_FILTERS.filter((s) => s !== "all") },
    product: {},
  },
  sortable: TICKET_TABLE_SORTS,
  defaultSort: { id: "updated", desc: true },
  pageSize: TICKETS_PAGE_SIZE,
});

export type TicketsListState = ListState<"status" | "product">;

/** Status tabs in prototype order: Open / Needs your reply / Resolved / All. */
export const TICKET_STATUS_TABS: readonly { value: TicketStatusFilter; label: string }[] = (
  ["open", "awaiting_customer", "resolved", "all"] as const
).map((value) => ({ value, label: TICKET_STATUS_FILTER_LABELS[value] }));

function isStatusFilter(value: string): value is TicketStatusFilter {
  return (TICKET_STATUS_FILTERS as readonly string[]).includes(value);
}

function isSortKey(value: string): value is (typeof TICKET_TABLE_SORTS)[number] {
  return (TICKET_TABLE_SORTS as readonly string[]).includes(value);
}

/** The listTickets() query for a parsed URL state (unknown values fall back to the defaults). */
export function ticketQueryFromListState(state: TicketsListState): TicketListQuery {
  const status = state.filters.status;
  const sort = state.sort && isSortKey(state.sort.id) ? state.sort : { id: "updated" as const, desc: true };
  return {
    status: isStatusFilter(status) ? status : "all",
    product: state.filters.product || "all",
    q: state.q,
    sort: { key: sort.id as TicketSortKey, dir: sort.desc ? -1 : 1 },
    page: state.page,
  };
}
