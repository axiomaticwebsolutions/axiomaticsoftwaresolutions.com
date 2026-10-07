"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { AdminCardContent } from "@/components/admin/admin-card";
import { StatusBadge } from "@/components/admin/status-badge";
import { LEAD_STATUS_LABELS, type LeadDto } from "@/lib/admin/leads/model";
import { relativeAgo } from "@/lib/admin/templates/relative";
import { formatDateTimeIST } from "@/lib/dates";

function Sub({ children }: { children: React.ReactNode }) {
  return <div className="mt-px text-[11.5px] font-semibold text-ink-2">{children}</div>;
}

/** What the request is about: the product for demo requests, the topic for messages. */
export function leadInterest(l: LeadDto): string {
  return l.kind === "DEMO" ? (l.productName ?? "Not sure yet") : (l.topicLabel ?? "\u2014");
}

/** REQUEST | TYPE | CONTACT | ABOUT | STATUS | RECEIVED (sort ids match LEAD_SORTS: name, status, received). */
export function leadColumns(now: string): ColumnDef<LeadDto>[] {
  return [
    {
      id: "name",
      header: "Request",
      accessorFn: (l) => l.name,
      cell: ({ row }) => (
        <>
          <div className="font-bold">{row.original.name}</div>
          <Sub>
            <span className="font-mono">{row.original.id}</span>
            {row.original.businessName ? ` \u00b7 ${row.original.businessName}` : null}
          </Sub>
        </>
      ),
      meta: { rowHeader: true, className: "min-w-[200px]" },
    },
    { id: "kind", header: "Type", enableSorting: false, cell: ({ row }) => row.original.kindLabel, meta: { className: "whitespace-nowrap" } },
    {
      id: "contact",
      header: "Contact",
      enableSorting: false,
      cell: ({ row }) => (
        <>
          <div className="break-all">{row.original.email}</div>
          {row.original.phone ? <Sub>{row.original.phone}</Sub> : null}
        </>
      ),
      meta: { className: "min-w-[180px]" },
    },
    { id: "about", header: "About", enableSorting: false, cell: ({ row }) => leadInterest(row.original) },
    {
      id: "status",
      header: "Status",
      accessorFn: (l) => l.status,
      cell: ({ row }) => <StatusBadge kind="lead" status={row.original.status} label={LEAD_STATUS_LABELS[row.original.status]} />,
    },
    {
      id: "received",
      header: "Received",
      accessorFn: (l) => l.createdAt,
      cell: ({ row }) => (
        <time dateTime={row.original.createdAt} title={formatDateTimeIST(new Date(row.original.createdAt))} className="whitespace-nowrap">
          {relativeAgo(row.original.createdAt, now)}
        </time>
      ),
      meta: { className: "whitespace-nowrap", sortLabels: { asc: "oldest first", desc: "newest first" } },
    },
  ];
}

export function leadCard(l: LeadDto): React.ReactNode {
  return (
    <AdminCardContent
      title={l.name}
      subtitle={
        <>
          {l.kindLabel} · <span className="font-mono">{l.id}</span> · {leadInterest(l)}
        </>
      }
      badge={<StatusBadge kind="lead" status={l.status} label={LEAD_STATUS_LABELS[l.status]} />}
    />
  );
}
