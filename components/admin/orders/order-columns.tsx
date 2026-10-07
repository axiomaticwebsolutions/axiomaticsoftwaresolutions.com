"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { AdminCardContent } from "@/components/admin/admin-card";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  formatOrderDate,
  formatTimeIST,
  money,
  type AdminOrderRow,
} from "@/lib/admin/orders/model";

/** Second line of a cell (prototype: 12px/600 #4B5567). */
const SUB = "mt-0.5 block text-[12px] font-semibold text-ink-2";

const col = createColumnHelper<AdminOrderRow>();

/**
 * Admin Console.dc.html orders columns: ORDER (mono id + invoice no.), DATE (date + time), CUSTOMER (business or name +
 * email), ITEMS (wrapping), STATUS badge, METHOD (latest attempt), TOTAL (bold, right, exact rupees + IGST or
 * CGST+SGST). Sorted by the server; the sort ids are the API's `sort` values.
 */
export const ORDER_COLUMNS = [
  col.accessor("id", {
    header: "Order",
    meta: { rowHeader: true, label: "Order", className: "whitespace-nowrap" },
    cell: ({ row }) => (
      <>
        <span className="block font-mono text-[13px] font-bold text-ink">{row.original.id}</span>
        {row.original.invoiceNumber ? <span className={`${SUB} font-mono`}>{row.original.invoiceNumber}</span> : null}
      </>
    ),
  }),
  col.accessor("createdAt", {
    header: "Date",
    meta: { label: "Date", sortLabels: { asc: "oldest first", desc: "newest first" } },
    cell: ({ getValue }) => (
      <span className="whitespace-nowrap">
        <span className="block">{formatOrderDate(getValue())}</span>
        <span className={SUB}>{formatTimeIST(getValue())}</span>
      </span>
    ),
  }),
  col.accessor("customer", {
    header: "Customer",
    meta: { label: "Customer" },
    cell: ({ row }) => (
      <span className="block min-w-0">
        <span className="block break-words">{row.original.customer}</span>
        <span className={SUB}>{row.original.email}</span>
      </span>
    ),
  }),
  col.accessor("items", {
    header: "Items",
    enableSorting: false,
    meta: { label: "Items", className: "min-w-[150px] max-w-[210px]" },
    cell: ({ getValue }) => <span className="block break-words">{getValue() || "\u2014"}</span>,
  }),
  col.accessor("status", {
    header: "Status",
    meta: { label: "Status" },
    cell: ({ getValue }) => <StatusBadge kind="order" status={getValue()} />,
  }),
  col.accessor("method", {
    header: "Method",
    enableSorting: false,
    meta: { label: "Method", className: "whitespace-nowrap" },
    cell: ({ getValue }) => getValue() ?? "\u2014",
  }),
  col.accessor("totalPaise", {
    header: "Total",
    meta: { align: "right", label: "Total" },
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        <span className="block font-extrabold tabular">{money(row.original.totalPaise)}</span>
        {row.original.taxLabel ? <span className={SUB}>{row.original.taxLabel}</span> : null}
      </span>
    ),
  }),
];

/** Phone card (prototype mobile: "AX-10262 · ₹23,598.82", "Spice Route Kitchen · 7 Oct 2026", status badge). */
export function orderCard(row: AdminOrderRow) {
  return (
    <AdminCardContent
      title={`${row.id} \u00B7 ${money(row.totalPaise)}`}
      subtitle={`${row.customer} \u00B7 ${formatOrderDate(row.createdAt)}`}
      badge={<StatusBadge kind="order" status={row.status} />}
    />
  );
}
