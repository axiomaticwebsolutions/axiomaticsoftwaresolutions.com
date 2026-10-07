"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { AdminCardContent } from "@/components/admin/admin-card";
import { StatusBadge } from "@/components/admin/status-badge";
import { couponUsageLabel, couponUsagePct, type CouponDto } from "@/lib/admin/coupons/model";
import { formatDateIST } from "@/lib/dates";

function TwoLine({ top, bottom, className }: { top: React.ReactNode; bottom?: React.ReactNode; className?: string }) {
  return (
    <>
      <div className={className}>{top}</div>
      {bottom ? <div className="mt-px text-[11.5px] font-semibold text-ink-2">{bottom}</div> : null}
    </>
  );
}

/** Prototype usage cell: "14 / 200" over an 80px bar (track line-subtle, fill primary). */
function Usage({ coupon }: { coupon: CouponDto }) {
  const pct = couponUsagePct(coupon);
  return (
    <>
      <div className="font-bold">{couponUsageLabel(coupon)}</div>
      {coupon.maxRedemptions !== null ? (
        <div aria-hidden="true" className="mt-1 h-1 w-20 overflow-hidden rounded-[2px] bg-line-subtle forced-color-adjust-none">
          <div className="h-full rounded-[2px] bg-primary" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </>
  );
}

/** CODE | DISCOUNT | APPLIES TO | STATUS | USAGE | VALID (prototype columns; sort ids match COUPON_SORTS). */
export const COUPON_COLUMNS: ColumnDef<CouponDto>[] = [
  {
    id: "code",
    header: "Code",
    accessorFn: (c) => c.code,
    cell: ({ row }) => <span className="font-mono text-[12.5px] font-bold">{row.original.code}</span>,
    meta: { rowHeader: true, className: "whitespace-nowrap" },
  },
  { id: "discount", header: "Discount", enableSorting: false, cell: ({ row }) => row.original.discountLabel, meta: { className: "whitespace-nowrap" } },
  { id: "scope", header: "Applies to", enableSorting: false, cell: ({ row }) => row.original.scope, meta: { className: "min-w-[180px]" } },
  {
    id: "status",
    header: "Status",
    accessorFn: (c) => c.status,
    cell: ({ row }) => <StatusBadge kind="coupon" status={row.original.status} />,
  },
  { id: "usage", header: "Usage", accessorFn: (c) => c.redemptions, cell: ({ row }) => <Usage coupon={row.original} /> },
  {
    id: "starts",
    header: "Valid",
    accessorFn: (c) => c.startsAt,
    cell: ({ row }) => (
      <TwoLine top={formatDateIST(new Date(row.original.startsAt))} bottom={`to ${formatDateIST(new Date(row.original.endsAt))}`} className="whitespace-nowrap" />
    ),
    meta: { className: "whitespace-nowrap", sortLabels: { asc: "oldest first", desc: "newest first" } },
  },
];

/** Phone card (prototype mobile row): code and status, then the scope. */
export function couponCard(c: CouponDto): React.ReactNode {
  return (
    <AdminCardContent title={c.code} subtitle={`${c.discountLabel} · ${c.scope}`} badge={<StatusBadge kind="coupon" status={c.status} />} />
  );
}
