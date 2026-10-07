"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { AdminCardContent } from "@/components/admin/admin-card";
import { StatusBadge } from "@/components/admin/status-badge";
import { relativeAgo, TEMPLATE_STATUS_LABELS, type TemplateDto } from "@/lib/admin/templates/model";
import { formatDateTimeIST } from "@/lib/dates";

/** TEMPLATE (name + id) | SUBJECT | CHANNEL | STATUS | UPDATED (prototype columns; relative times from the server's now). */
export function templateColumns(now: string): ColumnDef<TemplateDto>[] {
  return [
    {
      id: "name",
      header: "Template",
      accessorFn: (t) => t.name,
      cell: ({ row }) => (
        <>
          <div className="font-bold">{row.original.name}</div>
          <div className="mt-px font-mono text-[11.5px] font-semibold text-ink-2">{row.original.id}</div>
        </>
      ),
      meta: { rowHeader: true, className: "min-w-[180px]" },
    },
    { id: "subject", header: "Subject", enableSorting: false, cell: ({ row }) => row.original.subject, meta: { className: "min-w-[220px] break-words" } },
    { id: "channel", header: "Channel", enableSorting: false, cell: ({ row }) => row.original.channel },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => <StatusBadge kind="template" status={row.original.status} label={TEMPLATE_STATUS_LABELS[row.original.status]} />,
    },
    {
      id: "updated",
      header: "Updated",
      accessorFn: (t) => t.updatedAt ?? "",
      cell: ({ row }) =>
        row.original.updatedAt ? (
          <time dateTime={row.original.updatedAt} title={formatDateTimeIST(new Date(row.original.updatedAt))} className="whitespace-nowrap">
            {relativeAgo(row.original.updatedAt, now)}
          </time>
        ) : (
          <span className="text-ink-2">Never edited</span>
        ),
      meta: { className: "whitespace-nowrap", sortLabels: { asc: "oldest first", desc: "newest first" } },
    },
  ];
}

export function templateCard(t: TemplateDto): React.ReactNode {
  return (
    <AdminCardContent
      title={t.name}
      subtitle={t.subject}
      badge={<StatusBadge kind="template" status={t.status} label={TEMPLATE_STATUS_LABELS[t.status]} />}
    />
  );
}
