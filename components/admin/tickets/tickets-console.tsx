"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { useListState } from "@/components/data-table";
import { AdminBulkAction, AdminTable } from "@/components/admin/admin-table";
import { adminToast } from "@/components/admin/admin-toaster";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { apiFetch } from "@/lib/client/api";
import {
  ADMIN_TICKET_PRIORITIES,
  ADMIN_TICKET_STATUSES,
  ADMIN_TICKETS_LIST,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type TicketAssigneeOption,
  type TicketBulkAction,
  type TicketProductOption,
} from "@/lib/admin/tickets/model";
import type { AdminTicketRow, TicketBulkResult } from "@/lib/admin/tickets/service";
import { ticketCard, ticketColumns } from "./columns";
import { TicketDrawer } from "./ticket-drawer";

export type TicketsConsoleProps = {
  items: AdminTicketRow[];
  total: number;
  page: number;
  pageSize: number;
  assignees: readonly TicketAssigneeOption[];
  products: readonly TicketProductOption[];
  /** Server render time, so relative times match between the server and the browser. */
  nowIso: string;
};

const ALL = { value: "all", label: "All" };

const BULK_SUCCESS: Record<TicketBulkAction, string> = { assign_to_me: "Assigned to you", resolve: "Tickets resolved" };
const BULK_NOTHING: Record<TicketBulkAction, string> = {
  assign_to_me: "The selected tickets are already assigned to you.",
  resolve: "The selected tickets are already resolved or closed.",
};

/**
 * Support tickets table (Admin Console.dc.html #tickets): search, Status / Priority / Assignee / Product filters,
 * sortable Ticket, Priority, Status and Updated columns, the bulk bar (Assign to me, Mark resolved) and the ticket
 * drawer on `?id=`. List state lives in the URL and the server page renders the rows for it.
 */
export function TicketsConsole({ items, total, page, pageSize, assignees, products, nowIso }: TicketsConsoleProps) {
  const router = useRouter();
  const list = useListState(ADMIN_TICKETS_LIST);
  const drawer = useDrawerParam();
  const now = React.useMemo(() => new Date(nowIso), [nowIso]);
  const columns = React.useMemo(() => ticketColumns(now), [now]);
  const mobileCard = React.useMemo(() => ticketCard(now), [now]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = React.useState<TicketBulkAction | null>(null);
  const [refreshing, startRefresh] = React.useTransition();

  const refresh = React.useCallback(() => startRefresh(() => router.refresh()), [router]);

  const filters = list.state.filters;
  // A new search or filter is a new set of rows: drop the selection (prototype). Paging keeps it.
  const scope = JSON.stringify([list.applied.q, list.applied.filters]);
  const [selectionScope, setSelectionScope] = React.useState(scope);
  if (selectionScope !== scope) {
    setSelectionScope(scope);
    setSelected([]);
  }
  const assigneeOptions = React.useMemo(
    () => [ALL, { value: "me", label: "Me" }, { value: "none", label: "Unassigned" }, ...assignees.map((a) => ({ value: a.id, label: a.name }))],
    [assignees],
  );
  const productOptions = React.useMemo(() => [ALL, ...products.map((p) => ({ value: p.id, label: p.name }))], [products]);

  async function runBulk(action: TicketBulkAction) {
    if (bulkBusy || selected.length === 0) return;
    setBulkBusy(action);
    try {
      const result = await apiFetch<TicketBulkResult>("/api/admin/tickets/bulk", { method: "POST", body: { action, ids: selected } });
      if (result.updated.length > 0) adminToast.success(BULK_SUCCESS[action]);
      else adminToast.success(BULK_NOTHING[action]);
      setSelected([]);
      refresh();
    } catch (e) {
      adminToast.error(e);
    } finally {
      setBulkBusy(null);
    }
  }

  return (
    <>
      <AdminTable
        caption="Support tickets"
        columns={columns}
        data={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => `${row.id} ${row.subject}`}
        onRowClick={(row) => drawer.open(row.id)}
        manual
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        loading={list.isPending || refreshing}
        minWidth={940}
        mobileCard={mobileCard}
        rowClassName={(row) => (row.id === drawer.id ? "bg-lavender-soft" : undefined)}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: "Ticket, subject, business or email", label: "Search tickets" },
          filters: [
            {
              id: "status",
              label: "Status",
              options: [ALL, ...ADMIN_TICKET_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))],
              value: filters.status,
              onChange: (value) => list.setFilter("status", value),
            },
            {
              id: "priority",
              label: "Priority",
              options: [ALL, ...ADMIN_TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))],
              value: filters.priority,
              onChange: (value) => list.setFilter("priority", value),
            },
            { id: "assignee", label: "Assignee", options: assigneeOptions, value: filters.assignee, onChange: (value) => list.setFilter("assignee", value) },
            { id: "product", label: "Product", options: productOptions, value: filters.product, onChange: (value) => list.setFilter("product", value) },
          ],
          onClear: list.clear,
          canClear: list.isFiltered,
        }}
        resultCount={total}
        pagination={{ page, pageSize, total, onPageChange: list.setPage, pageHref: list.pageHref, label: "Ticket pages" }}
        selection={{
          selected,
          onChange: setSelected,
          bulkActions: (
            <>
              <AdminBulkAction perm="tickets.manage" disabled={bulkBusy !== null} onClick={() => void runBulk("assign_to_me")}>
                Assign to me
              </AdminBulkAction>
              <AdminBulkAction perm="tickets.manage" disabled={bulkBusy !== null} onClick={() => void runBulk("resolve")}>
                Mark resolved
              </AdminBulkAction>
            </>
          ),
        }}
      />
      <TicketDrawer ticketId={drawer.id} onOpenChange={drawer.onOpenChange} assignees={assignees} onChanged={refresh} />
    </>
  );
}
