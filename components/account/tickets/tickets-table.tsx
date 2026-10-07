"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, DataTableEmptyState, useListState } from "@/components/data-table";
import { relativeTime, ticketPath } from "@/components/account/portal-nav";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatDateTimeIST } from "@/lib/dates";
import { TICKET_STATUS_TABS, TICKETS_LIST } from "@/components/account/tickets/list-config";
import { TICKETS_COPY } from "@/components/account/tickets/model";
import { TicketPriority, TicketStatusBadge } from "@/components/account/tickets/ticket-bits";
import type { TicketListPage, TicketSummary } from "@/lib/portal/tickets";
import type { TicketStatusFilter } from "@/lib/validation/tickets";

export type TicketsTableProps = {
  list: TicketListPage;
  /** Products the account's tickets are about (the Product filter shows with two or more). */
  products: readonly { id: string; name: string }[];
  /** "Standard support: first reply within 1 business day · ..." */
  footerNote: string;
  /** Server render time (relative times render the same on the server and in the browser). */
  nowIso: string;
};

function buildColumns(now: Date): ColumnDef<TicketSummary>[] {
  return [
    {
      id: "created",
      header: "Ticket",
      enableSorting: true,
      sortDescFirst: true,
      meta: { rowHeader: true, label: "Ticket", sortLabels: { asc: "oldest first", desc: "newest first" } },
      cell: ({ row }) => (
        <span className="block min-w-[220px]">
          <span className="block font-mono text-[12.5px] text-ink-2">{row.original.id}</span>
          <span className="block font-extrabold">{row.original.subject}</span>
        </span>
      ),
    },
    {
      id: "product",
      header: "Product",
      enableSorting: false,
      meta: { className: "whitespace-nowrap font-semibold" },
      cell: ({ row }) => row.original.productShortName ?? row.original.productName ?? "\u2014",
    },
    {
      id: "priority",
      header: "Priority",
      enableSorting: true,
      sortDescFirst: true,
      meta: { sortLabels: { asc: "lowest first", desc: "highest first" } },
      cell: ({ row }) => <TicketPriority priority={row.original.priority} label={row.original.priorityLabel} />,
    },
    {
      id: "status",
      header: "Status",
      enableSorting: true,
      cell: ({ row }) => <TicketStatusBadge status={row.original.status} label={row.original.statusLabel} />,
    },
    {
      id: "updated",
      header: "Updated",
      enableSorting: true,
      sortDescFirst: true,
      meta: { className: "whitespace-nowrap font-semibold", sortLabels: { asc: "oldest first", desc: "newest first" } },
      cell: ({ row }) => (
        <time dateTime={row.original.updatedAt} title={formatDateTimeIST(new Date(row.original.updatedAt))}>
          {relativeTime(new Date(row.original.updatedAt), now)}
        </time>
      ),
    },
    {
      id: "raisedBy",
      header: "Raised by",
      enableSorting: false,
      meta: { className: "whitespace-nowrap font-semibold" },
      cell: ({ row }) => row.original.raisedBy,
    },
  ];
}

/** Card below 760px: id, subject, status and priority, product, updated and who raised it. */
function makeMobileCard(now: Date) {
  return function TicketCard(ticket: TicketSummary) {
    return (
      <>
        <span className="block">
          <span className="block font-mono text-[12.5px] text-ink-2">{ticket.id}</span>
          <span className="block text-[14px] font-extrabold">{ticket.subject}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
          <TicketStatusBadge status={ticket.status} label={ticket.statusLabel} />
          <TicketPriority priority={ticket.priority} label={ticket.priorityLabel} />
          <span className="font-semibold">{ticket.productShortName ?? ticket.productName ?? "\u2014"}</span>
        </span>
        <span className="block text-[12.5px] font-semibold text-ink-2">
          Updated {relativeTime(new Date(ticket.updatedAt), now)} {"\u00B7"} {ticket.raisedBy}
        </span>
      </>
    );
  };
}

/**
 * Support tickets table (prototype "Support tickets"): search "Ticket ID or subject", status tabs Open / Needs your
 * reply / Resolved / All, a Product filter when tickets cover several products, sortable Ticket, Priority, Status
 * and Updated columns, rows linking to the ticket, and the support-hours footer. The list state lives in the URL;
 * the server page renders the rows for it.
 */
export function TicketsTable({ list, products, footerNote, nowIso }: TicketsTableProps) {
  const listState = useListState(TICKETS_LIST);
  const now = React.useMemo(() => new Date(nowIso), [nowIso]);
  const columns = React.useMemo(() => buildColumns(now), [now]);
  const mobileCard = React.useMemo(() => makeMobileCard(now), [now]);
  const status = listState.state.filters.status as TicketStatusFilter;
  const product = listState.state.filters.product;

  const productOptions = React.useMemo(
    () => [{ value: "all", label: TICKETS_COPY.allProducts }, ...products.map((p) => ({ value: p.id, label: p.name }))],
    [products],
  );
  const showProductFilter = products.length >= 2 || product !== "all";
  const paged = list.pageCount > 1 || list.page > 1;

  return (
    <DataTable
      caption={TICKETS_COPY.caption}
      columns={columns}
      data={list.tickets}
      getRowId={(ticket) => ticket.id}
      getRowLabel={(ticket) => `${ticket.id} ${ticket.subject}`}
      rowHref={(ticket) => ticketPath(ticket.id)}
      manual
      sorting={listState.sorting}
      onSortingChange={listState.onSortingChange}
      loading={listState.isPending}
      minWidth={760}
      mobileCard={mobileCard}
      toolbar={{
        search: {
          value: listState.state.q,
          onChange: listState.setQuery,
          placeholder: TICKETS_COPY.searchPlaceholder,
          label: TICKETS_COPY.searchLabel,
        },
        controls: (
          <SegmentedControl
            variant="chip"
            className="max-[25rem]:[&>button]:px-2"
            aria-label={TICKETS_COPY.statusLabel}
            options={TICKET_STATUS_TABS}
            value={status}
            onValueChange={(value) => listState.setFilter("status", value)}
          />
        ),
        filters: showProductFilter
          ? [
              {
                id: "product",
                label: TICKETS_COPY.productFilter,
                options: productOptions,
                value: product,
                onChange: (value: string) => listState.setFilter("product", value),
              },
            ]
          : undefined,
        onClear: listState.clear,
        canClear: listState.isFiltered,
      }}
      pagination={
        paged
          ? {
              page: list.page,
              pageSize: list.pageSize,
              total: list.total,
              onPageChange: listState.setPage,
              pageHref: listState.pageHref,
              label: "Ticket pages",
              rangeLabel: ({ from, to, total }) => `${footerNote} \u00B7 Showing ${from}\u2013${to} of ${total.toLocaleString("en-IN")}`,
            }
          : undefined
      }
      footer={paged ? undefined : footerNote}
      emptyState={<DataTableEmptyState>{TICKETS_COPY.empty}</DataTableEmptyState>}
    />
  );
}
