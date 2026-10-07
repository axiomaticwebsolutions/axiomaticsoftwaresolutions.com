"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { AdminCardContent } from "@/components/admin/admin-card";
import { TwoLine } from "@/components/admin/licenses/cells";
import { StatusBadge } from "@/components/admin/status-badge";
import { formatDateIST } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { RENEWAL_COPY, renewalDaysCell, type AdminRenewalRow } from "@/lib/admin/renewals/model";
import { cn } from "@/lib/utils";

const col = createColumnHelper<AdminRenewalRow>();

const DAY_TONES = { danger: "text-danger", warn: "text-peach-fg", default: "text-ink" } as const;

/** Renewals table (Admin Console.dc.html mods.renewals cols); AUTO-RENEW becomes LAST REMINDER (decisions rule 2). */
export const RENEWAL_COLUMNS = [
  col.accessor("id", {
    id: "id",
    header: "License",
    meta: { rowHeader: true, className: "whitespace-nowrap" },
    cell: ({ row }) => <TwoLine strong title={row.original.id} sub={`${row.original.productShortName} \u00B7 ${row.original.planName}`} />,
  }),
  col.accessor("customerName", {
    id: "customer",
    header: "Customer",
    meta: { className: "whitespace-nowrap", sortLabels: { asc: "A to Z", desc: "Z to A" } },
    cell: ({ row }) => <TwoLine title={row.original.customerName} sub={row.original.customerEmail ?? undefined} />,
  }),
  col.accessor("expiresAt", {
    id: "ends",
    header: "Ends",
    meta: { className: "whitespace-nowrap font-semibold", sortLabels: { asc: "ending soonest", desc: "ending last" } },
    cell: ({ row }) => formatDateIST(new Date(row.original.expiresAt)),
  }),
  col.accessor("daysLeft", {
    id: "days",
    header: "Days",
    meta: { align: "right", className: "whitespace-nowrap tabular", sortLabels: { asc: "fewest first", desc: "most first" } },
    cell: ({ row }) => {
      const cell = renewalDaysCell(row.original.daysLeft);
      return <span className={cn("font-bold", DAY_TONES[cell.tone])}>{cell.label}</span>;
    },
  }),
  col.accessor("renewalValuePaise", {
    id: "value",
    header: "Renewal value",
    meta: { align: "right", className: "whitespace-nowrap tabular font-semibold" },
    cell: ({ row }) => formatINR(row.original.renewalValuePaise),
  }),
  col.accessor("lastReminderAt", {
    id: "reminder",
    header: "Last reminder",
    enableSorting: false,
    meta: { className: "whitespace-nowrap font-semibold" },
    cell: ({ row }) =>
      row.original.lastReminderAt ? (
        formatDateIST(new Date(row.original.lastReminderAt))
      ) : (
        <span className="text-ink-2">{RENEWAL_COPY.notSent}</span>
      ),
  }),
];

/** Days left for the phone card: "11 days left", "Due today", "Lapsed 3 days ago". */
export function daysLeftText(days: number): string {
  if (days < 0) return `Lapsed ${-days} ${days === -1 ? "day" : "days"} ago`;
  if (days === 0) return "Due today";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

/** Card below 760px (prototype mobile: id, end date, status badge). */
export function renewalCard(row: AdminRenewalRow) {
  const cell = renewalDaysCell(row.daysLeft);
  return (
    <AdminCardContent
      title={`${row.id} · ${row.productShortName}`}
      subtitle={
        <>
          {`${formatDateIST(new Date(row.expiresAt))} · `}
          <span className={DAY_TONES[cell.tone]}>{daysLeftText(row.daysLeft)}</span>
        </>
      }
      badge={<StatusBadge kind="license" status={row.status} />}
    />
  );
}
