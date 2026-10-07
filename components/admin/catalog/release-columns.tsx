"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { platformList, releaseChannelLabel } from "@/lib/admin/catalog/model";
import type { AdminReleaseRow } from "@/lib/admin/catalog/types";
import { formatDateIST } from "@/lib/dates";
import { formatFileSize } from "@/lib/storefront/derive";
import { TwoLine } from "./shared";

/** "15 Sep 2026", or "Not published" for drafts. */
export function releaseDateLabel(r: Pick<AdminReleaseRow, "releasedAt">): string {
  return r.releasedAt ? formatDateIST(new Date(r.releasedAt)) : "Not published";
}

/** RELEASE | DATE | PLATFORMS | INSTALLER | CHANNEL | STATUS (prototype columns; sort ids match RELEASE_SORTS). */
export const RELEASE_COLUMNS: ColumnDef<AdminReleaseRow>[] = [
  {
    id: "release",
    header: "Release",
    accessorFn: (r) => `${r.productName} ${r.version}`,
    cell: ({ row }) => <TwoLine bold top={`${row.original.productName} v${row.original.version}`} bottom={row.original.firstNote} />,
    meta: { rowHeader: true, className: "min-w-[220px]" },
  },
  {
    id: "date",
    header: "Date",
    accessorFn: (r) => r.releasedAt ?? "",
    cell: ({ row }) => <span className={row.original.releasedAt ? undefined : "text-ink-2"}>{releaseDateLabel(row.original)}</span>,
    meta: { className: "whitespace-nowrap", sortLabels: { asc: "oldest first", desc: "newest first" } },
  },
  {
    id: "platforms",
    header: "Platforms",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.platforms.length > 0 ? platformList(row.original.platforms) : <span className="text-ink-2">No installers yet</span>,
  },
  {
    id: "installer",
    header: "Installer",
    enableSorting: false,
    cell: ({ row }) => (row.original.installerBytes === null ? <span className="text-ink-2">{"\u2014"}</span> : formatFileSize(row.original.installerBytes)),
    meta: { align: "right", className: "whitespace-nowrap" },
  },
  { id: "channel", header: "Channel", enableSorting: false, cell: ({ row }) => releaseChannelLabel(row.original.channel) },
  { id: "status", header: "Status", enableSorting: false, cell: ({ row }) => <StatusBadge kind="release" status={row.original.status} /> },
];

/** Phone card (prototype mobile row): "Product vX" with the status, then the date. */
export function releaseCard(r: AdminReleaseRow): React.ReactNode {
  return (
    <span className="grid gap-1">
      <span className="flex items-start justify-between gap-2.5">
        <span className="text-[14px] font-extrabold">
          {r.productName} v{r.version}
        </span>
        <StatusBadge kind="release" status={r.status} />
      </span>
      <span className="text-[12.5px] font-semibold text-ink-2">{releaseDateLabel(r)}</span>
    </span>
  );
}
