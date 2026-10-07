"use client";

import Link from "next/link";
import { createColumnHelper } from "@tanstack/react-table";
import { formatDateIST } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { deviceUsage, licenseHref, termInfo, type LicenseListRow } from "./model";
import { LicenseStatusBadge, ProductTile, SMALL_OUTLINE } from "./ui";

const col = createColumnHelper<LicenseListRow>();

/** LICENSE cell: tone tile, product short name, "{LIC} · {plan}". */
export function LicenseNameCell({ row }: { row: LicenseListRow }) {
  return (
    <span className="flex items-center gap-2.5">
      <ProductTile icon={row.productIcon} tone={row.productTone} />
      <span className="min-w-0">
        <span className="block font-extrabold">{row.productShortName}</span>
        <span className="block text-[12.5px] font-semibold text-ink-2">
          {row.id} · {row.planName}
        </span>
      </span>
    </span>
  );
}

export function DeviceUsageBar({ used, limit, className }: { used: number; limit: number; className?: string }) {
  const usage = deviceUsage(used, limit);
  return (
    <span className={cn("mt-[5px] block h-[5px] overflow-hidden rounded-pill bg-line-subtle forced-color-adjust-none", className)}>
      <span className={cn("block h-full", usage.full ? "bg-warn-bar" : "bg-primary")} style={{ width: `${usage.pct}%` }} />
    </span>
  );
}

/** Columns of the license table in prototype order; every column but KEY sorts (manual: the view sorts the rows). */
export function licenseColumns(now: Date) {
  return [
    col.accessor("productShortName", {
      id: "product",
      header: "License",
      meta: { rowHeader: true, className: "whitespace-nowrap", sortLabels: { asc: "A to Z", desc: "Z to A" } },
      cell: ({ row }) => <LicenseNameCell row={row.original} />,
    }),
    col.accessor("keyMasked", {
      id: "key",
      header: "Key",
      enableSorting: false,
      meta: { className: "whitespace-nowrap font-mono text-[12.5px] text-ink-2" },
    }),
    col.accessor("status", {
      id: "status",
      header: "Status",
      cell: ({ row }) => <LicenseStatusBadge status={row.original.status} />,
    }),
    col.accessor("expiresAt", {
      id: "expiry",
      header: "Term",
      meta: { className: "whitespace-nowrap font-semibold", sortLabels: { asc: "ending soonest", desc: "ending last" } },
      cell: ({ row }) => {
        const term = termInfo(row.original.expiresAt, now);
        return (
          <>
            {term.label}
            <span className={cn("block text-[12px] font-bold", term.warn ? "text-peach-fg" : "text-ink-2")}>{term.sub}</span>
          </>
        );
      },
    }),
    col.accessor((r) => (r.deviceLimit > 0 ? r.devicesUsed / r.deviceLimit : 0), {
      id: "devices",
      header: "Devices",
      meta: { className: "min-w-[120px]", sortLabels: { asc: "least used first", desc: "most used first" } },
      cell: ({ row }) => (
        <>
          <span className="block font-bold">{deviceUsage(row.original.devicesUsed, row.original.deviceLimit).label}</span>
          <DeviceUsageBar used={row.original.devicesUsed} limit={row.original.deviceLimit} />
        </>
      ),
    }),
    col.accessor("updatesUntil", {
      id: "updates",
      header: "Updates until",
      meta: { className: "whitespace-nowrap font-semibold", sortLabels: { asc: "ending soonest", desc: "ending last" } },
      cell: ({ row }) => formatDateIST(new Date(row.original.updatesUntil)),
    }),
    col.display({
      id: "actions",
      meta: { srLabel: "Actions", align: "right", className: "whitespace-nowrap" },
      cell: ({ row }) => (
        <Link href={licenseHref(row.original.id)} aria-label={`Manage ${row.original.id}`} className={SMALL_OUTLINE}>
          Manage
        </Link>
      ),
    }),
  ];
}

/** Card below 760px (prototype): tile, product, "{LIC} · {plan}", status; then term and devices. */
export function licenseCard(row: LicenseListRow) {
  return (
    <>
      <span className="flex items-center gap-2.5">
        <ProductTile icon={row.productIcon} tone={row.productTone} />
        <span className="min-w-0 flex-1">
          <span className="block font-extrabold">{row.productShortName}</span>
          <span className="block text-[12.5px] font-semibold text-ink-2">
            {row.id} · {row.planName}
          </span>
        </span>
        <LicenseStatusBadge status={row.status} />
      </span>
      <span className="flex justify-between gap-3 text-[13px] font-semibold text-ink-2">
        <span>{row.expiresAt ? formatDateIST(new Date(row.expiresAt)) : "No end date"}</span>
        <span>{deviceUsage(row.devicesUsed, row.deviceLimit).label}</span>
      </span>
    </>
  );
}
