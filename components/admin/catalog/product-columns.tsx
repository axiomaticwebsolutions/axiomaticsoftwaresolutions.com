"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { platformList } from "@/lib/admin/catalog/model";
import type { AdminCategoryRow, AdminProductRow } from "@/lib/admin/catalog/types";
import { formatDateIST } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { TwoLine } from "./shared";

/** PRODUCT | CATEGORY | PLATFORMS | LATEST | PLANS | FROM | STATUS (prototype columns; sort ids match PRODUCT_SORTS). */
export const PRODUCT_COLUMNS: ColumnDef<AdminProductRow>[] = [
  {
    id: "name",
    header: "Product",
    accessorFn: (p) => p.name,
    cell: ({ row }) => <TwoLine bold top={row.original.shortName} bottom={`${row.original.code} \u00B7 ${row.original.id}`} />,
    meta: { rowHeader: true, className: "min-w-[180px]" },
  },
  { id: "category", header: "Category", enableSorting: false, cell: ({ row }) => row.original.categoryName },
  { id: "platforms", header: "Platforms", enableSorting: false, cell: ({ row }) => platformList(row.original.platforms) },
  {
    id: "latest",
    header: "Latest",
    accessorFn: (p) => p.latest?.version ?? "",
    cell: ({ row }) => {
      const latest = row.original.latest;
      return latest ? <TwoLine top={`v${latest.version}`} bottom={formatDateIST(new Date(latest.releasedAt))} /> : <span className="text-ink-2">No release yet</span>;
    },
    meta: { className: "whitespace-nowrap", sortLabels: { asc: "oldest version first", desc: "newest version first" } },
  },
  { id: "plans", header: "Plans", enableSorting: false, cell: ({ row }) => row.original.planCount, meta: { align: "right" } },
  {
    id: "price",
    header: "From",
    accessorFn: (p) => p.fromPricePaise ?? 0,
    cell: ({ row }) => (row.original.fromPricePaise === null ? <span className="text-ink-2">{"\u2014"}</span> : formatINR(row.original.fromPricePaise)),
    meta: { align: "right", className: "whitespace-nowrap" },
  },
  { id: "status", header: "Status", enableSorting: false, cell: ({ row }) => <StatusBadge kind="product" status={row.original.status} /> },
];

/** Phone card (prototype mobile row): display name and status, then category and latest version. */
export function productCard(p: AdminProductRow): React.ReactNode {
  return (
    <span className="grid gap-1">
      <span className="flex items-center justify-between gap-2.5">
        <span className="text-[14px] font-extrabold">{p.shortName}</span>
        <StatusBadge kind="product" status={p.status} />
      </span>
      <span className="text-[12.5px] font-semibold text-ink-2">
        {p.categoryName}
        {p.latest ? ` \u00B7 v${p.latest.version}` : ""}
      </span>
    </span>
  );
}

/** "2 published" or "2 published · 5 coming soon". */
export function categoryCountDetail(c: Pick<AdminCategoryRow, "publishedCount" | "comingSoonCount">): string {
  return c.comingSoonCount > 0 ? `${c.publishedCount} published \u00B7 ${c.comingSoonCount} coming soon` : `${c.publishedCount} published`;
}

/** NAME | PRODUCTS | ORDER (the categories card under the products table). */
export const CATEGORY_COLUMNS: ColumnDef<AdminCategoryRow>[] = [
  {
    id: "name",
    header: "Category",
    enableSorting: false,
    cell: ({ row }) => <TwoLine bold top={row.original.name} bottom={row.original.id} />,
    meta: { rowHeader: true, className: "min-w-[180px]" },
  },
  {
    id: "blurb",
    header: "Description",
    enableSorting: false,
    cell: ({ row }) => <span className="text-ink-2">{row.original.blurb ?? "\u2014"}</span>,
    meta: { className: "min-w-[220px]" },
  },
  {
    id: "products",
    header: "Products",
    enableSorting: false,
    cell: ({ row }) => <TwoLine top={row.original.productCount} bottom={categoryCountDetail(row.original)} />,
    meta: { align: "right", className: "whitespace-nowrap" },
  },
  { id: "order", header: "Order", enableSorting: false, cell: ({ row }) => row.original.sortOrder, meta: { align: "right" } },
];

export function categoryCard(c: AdminCategoryRow): React.ReactNode {
  return (
    <span className="grid gap-1">
      <span className="text-[14px] font-extrabold">{c.name}</span>
      <span className="text-[12.5px] font-semibold text-ink-2">
        {c.productCount} {c.productCount === 1 ? "product" : "products"} {"\u00B7"} {categoryCountDetail(c)}
      </span>
    </span>
  );
}
