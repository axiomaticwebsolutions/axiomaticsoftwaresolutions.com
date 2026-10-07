"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { Badge } from "@/components/ui/badge";
import { planDeviceLimitLabel, planPriceLines, planTermLabel, planTypeBadge, planUpdatesLabel } from "@/lib/admin/catalog/model";
import type { AdminPlanRow } from "@/lib/admin/catalog/types";
import { TwoLine } from "./shared";

function TypeBadge({ plan }: { plan: Pick<AdminPlanRow, "type" | "multiDevice"> }) {
  const badge = planTypeBadge(plan);
  return (
    <Badge tone={badge.tone} size="sm" className="leading-[normal]">
      {badge.label}
    </Badge>
  );
}

/**
 * PLAN | PRODUCT | TYPE | PRICE | TERM | DEVICE LIMIT | UPDATES | STATUS (prototype columns; sort ids match PLAN_SORTS).
 * The incl.-GST line uses the configured GST rate.
 */
export function planColumns(gstRatePct: number): ColumnDef<AdminPlanRow>[] {
  return [
    {
      id: "name",
      header: "Plan",
      accessorFn: (p) => p.name,
      cell: ({ row }) => <TwoLine bold top={row.original.name} bottom={row.original.id} />,
      meta: { rowHeader: true, className: "min-w-[170px]" },
    },
    { id: "product", header: "Product", accessorFn: (p) => p.productName, cell: ({ row }) => row.original.productName, meta: { className: "min-w-[140px]" } },
    { id: "type", header: "Type", enableSorting: false, cell: ({ row }) => <TypeBadge plan={row.original} /> },
    {
      id: "price",
      header: "Price",
      accessorFn: (p) => p.pricePaise,
      cell: ({ row }) => {
        const lines = planPriceLines(row.original.pricePaise, gstRatePct);
        return <TwoLine top={lines.price} bottom={lines.inclGst} />;
      },
      meta: { align: "right", className: "whitespace-nowrap" },
    },
    { id: "term", header: "Term", enableSorting: false, cell: ({ row }) => planTermLabel(row.original), meta: { className: "whitespace-nowrap" } },
    { id: "devices", header: "Device limit", enableSorting: false, cell: ({ row }) => planDeviceLimitLabel(row.original) },
    { id: "updates", header: "Updates", enableSorting: false, cell: ({ row }) => planUpdatesLabel(row.original), meta: { className: "whitespace-nowrap" } },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => <StatusBadge kind="plan" status={row.original.archived ? "archived" : "active"} />,
    },
  ];
}

/** Phone card (prototype mobile row): "Product · Plan" with the type, then the price. */
export function planCard(p: AdminPlanRow): React.ReactNode {
  return (
    <span className="grid gap-1">
      <span className="flex items-start justify-between gap-2.5">
        <span className="text-[14px] font-extrabold">
          {p.productName} {"\u00B7"} {p.name}
        </span>
        <TypeBadge plan={p} />
      </span>
      <span className="text-[12.5px] font-semibold text-ink-2">
        {planPriceLines(p.pricePaise, 0).price}
        {p.archived ? " \u00B7 Archived" : ""}
      </span>
    </span>
  );
}
