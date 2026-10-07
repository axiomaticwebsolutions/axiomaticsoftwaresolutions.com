"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { formatTicketDateTime, relativeTicketTime } from "@/lib/admin/tickets/model";
import type { AdminTicketRow } from "@/lib/admin/tickets/service";

/**
 * Prototype columns: TICKET (subject + id, sorts by id) · CUSTOMER (business + email) · PRODUCT · PRIORITY (High
 * first) · STATUS · ASSIGNEE ("Unassigned" in peach) · UPDATED (relative, default newest first). As in the prototype,
 * a header click on another column sorts it ascending first.
 */
/**
 * An email that may wrap after the "@" ("ananya@" / "raodepartmentalstore.example"), so long addresses no longer set
 * the CUSTOMER column's width and the 940px table fits its card at 1280px with the Open column in view.
 */
function EmailWithBreak({ email }: { email: string }) {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return (
    <>
      {email.slice(0, at + 1)}
      <wbr />
      {email.slice(at + 1)}
    </>
  );
}

export function ticketColumns(now: Date): ColumnDef<AdminTicketRow>[] {
  return [
    {
      id: "id",
      header: "Ticket",
      enableSorting: true,
      meta: { rowHeader: true, label: "Ticket", sortLabels: { asc: "oldest first", desc: "newest first" } },
      cell: ({ row }) => (
        <span className="block min-w-[150px] max-w-[240px]">
          <span className="block break-words font-extrabold">{row.original.subject}</span>
          <span className="block text-[11.5px] font-semibold text-ink-2">{row.original.id}</span>
        </span>
      ),
    },
    {
      id: "customer",
      header: "Customer",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="block min-w-[140px]">
          <span className="block font-semibold">{row.original.account.name || row.original.customer?.name || "\u2014"}</span>
          {row.original.customer ? (
            <span className="block break-words text-[11.5px] font-semibold text-ink-2">
              <EmailWithBreak email={row.original.customer.email} />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "product",
      header: "Product",
      enableSorting: false,
      meta: { className: "font-semibold" },
      cell: ({ row }) => (
        <span className="block min-w-[90px]">{row.original.product ? row.original.product.shortName || row.original.product.name : "\u2014"}</span>
      ),
    },
    {
      id: "priority",
      header: "Priority",
      enableSorting: true,
      meta: { sortLabels: { asc: "high first", desc: "low first" } },
      cell: ({ row }) => <StatusBadge kind="priority" status={row.original.priority} />,
    },
    {
      id: "status",
      header: "Status",
      enableSorting: true,
      cell: ({ row }) => <StatusBadge kind="ticket" status={row.original.status} className="whitespace-nowrap" />,
    },
    {
      id: "assignee",
      header: "Assignee",
      enableSorting: false,
      meta: { className: "whitespace-nowrap font-semibold" },
      cell: ({ row }) =>
        row.original.assignee ? row.original.assignee.name : <span className="text-peach-fg">Unassigned</span>,
    },
    {
      id: "updatedAt",
      header: "Updated",
      enableSorting: true,
      meta: { className: "whitespace-nowrap font-semibold", sortLabels: { asc: "oldest first", desc: "newest first" } },
      cell: ({ row }) => (
        <time dateTime={row.original.updatedAt} title={formatTicketDateTime(row.original.updatedAt)}>
          {relativeTicketTime(row.original.updatedAt, now)}
        </time>
      ),
    },
  ];
}

/** Card below 760px (prototype mobile: subject + status badge, "{id} · {updated}"). Phrasing content only. */
export function ticketCard(now: Date) {
  return function TicketCard(row: AdminTicketRow) {
    return (
      <>
        <span className="flex items-start justify-between gap-2.5">
          <span className="min-w-0 break-words text-[14px] font-extrabold">{row.subject}</span>
          <StatusBadge kind="ticket" status={row.status} className="shrink-0" />
        </span>
        <span className="block text-[12.5px] font-semibold text-ink-2">
          {row.id} {"\u00B7"} {relativeTicketTime(row.updatedAt, now)}
          {row.priority === "high" ? ` \u00B7 High priority` : ""}
          {row.assignee ? "" : ` \u00B7 Unassigned`}
        </span>
      </>
    );
  };
}
