"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { AdminCardContent } from "@/components/admin/admin-card";
import { StatusBadge } from "@/components/admin/status-badge";
import { formatDateIST } from "@/lib/dates";
import type { AdminLicenseRow } from "@/lib/admin/licenses/model";
import { cn } from "@/lib/utils";
import { DeviceUsageCell, TwoLine } from "./cells";
import { expiresSoon } from "./expires";

const col = createColumnHelper<AdminLicenseRow>();

/** EXPIRES cell: the date (amber when it is soon, see expires.ts), or "No end date" for perpetual licenses. */
export function ExpiresCell({ row, nowMs }: { row: AdminLicenseRow; nowMs: number }) {
  if (!row.expiresAt) return <span className="font-semibold">No end date</span>;
  const soon = expiresSoon(row.expiresAt, nowMs);
  return <span className={cn("whitespace-nowrap font-semibold", soon ? "text-peach-fg" : "text-ink")}>{formatDateIST(new Date(row.expiresAt))}</span>;
}

/**
 * Licenses table (Admin Console.dc.html mods.licenses cols), server-sorted by the column ids. `nowIso` is the server's
 * time of the page, so the EXPIRES colour renders the same on the server and in the browser.
 */
export function licenseColumns(nowIso: string) {
  const nowMs = Date.parse(nowIso);
  return [
    col.accessor("id", {
      id: "id",
      header: "License",
      meta: { rowHeader: true, className: "whitespace-nowrap" },
      cell: ({ row }) => <TwoLine strong title={row.original.id} sub={row.original.productShortName} />,
    }),
    col.accessor("customerName", {
      id: "customer",
      header: "Customer",
      meta: { className: "whitespace-nowrap", sortLabels: { asc: "A to Z", desc: "Z to A" } },
      cell: ({ row }) => <TwoLine title={row.original.customerName} sub={row.original.customerEmail ?? undefined} />,
    }),
    col.accessor("planName", { id: "plan", header: "Plan", enableSorting: false, meta: { className: "whitespace-nowrap font-semibold" } }),
    col.accessor("keyMasked", {
      id: "key",
      header: "Key",
      enableSorting: false,
      meta: { className: "whitespace-nowrap font-mono text-[12px] text-ink-2" },
    }),
    col.accessor("status", {
      id: "status",
      header: "Status",
      meta: { className: "whitespace-nowrap" },
      cell: ({ row }) => <StatusBadge kind="license" status={row.original.status} />,
    }),
    col.accessor("expiresAt", {
      id: "expires",
      header: "Expires",
      meta: { sortLabels: { asc: "ending soonest", desc: "ending last" } },
      cell: ({ row }) => <ExpiresCell row={row.original} nowMs={nowMs} />,
    }),
    col.accessor((r) => (r.deviceLimit > 0 ? r.devicesUsed / r.deviceLimit : 0), {
      id: "devices",
      header: "Devices",
      meta: { sortLabels: { asc: "least used first", desc: "most used first" } },
      cell: ({ row }) => <DeviceUsageCell used={row.original.devicesUsed} limit={row.original.deviceLimit} />,
    }),
    col.accessor("issuedAt", {
      id: "issued",
      header: "Issued",
      meta: { className: "whitespace-nowrap font-semibold", sortLabels: { asc: "oldest first", desc: "newest first" } },
      cell: ({ row }) => formatDateIST(new Date(row.original.issuedAt)),
    }),
  ];
}

/** Card below 760px (prototype mobile: "{id} · {product}", email, status badge). */
export function licenseCard(row: AdminLicenseRow) {
  return (
    <AdminCardContent
      title={`${row.id} \u00B7 ${row.productShortName}`}
      subtitle={row.customerEmail ?? row.customerName}
      badge={<StatusBadge kind="license" status={row.status} />}
    />
  );
}
