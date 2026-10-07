"use client";

import * as React from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ApiClientError } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { downloadFile } from "./download";
import {
  ORDERS_COPY,
  orderDateLabel,
  orderHref,
  orderInvoiceLabel,
  orderRowAction,
  orderTaxLabel,
  orderTotalLabel,
  type AccountOrderRow,
} from "./orders-model";

/** Second line of a cell (prototype: 12px/600 #4B5567). */
const SUB = "mt-0.5 block text-[12px] font-semibold text-ink-2";
/** Prototype order cells: 12px 14px. */
const PAD = "px-3.5";
/** Prototype row button: 6px 12px, radius 9, #CBD2DF border, 13px/700, 16px icon. */
const ACTION = "h-auto gap-1 rounded-9 px-3 py-1.5 text-[13px] leading-[normal]";
/** Mono order id link: reads as the prototype's plain mono id, underlined on hover. */
const ID_LINK = "rounded-6 font-mono text-[13px] text-ink no-underline hover:text-ink hover:underline";

/** Order status pill (prototype: 3px 9px, radius 99, 12px/800, tone from lib/portal/orders ORDER_STATUS_BADGES). */
export function OrderStatusPill({ row }: { row: Pick<AccountOrderRow, "badge"> }) {
  return (
    <Badge tone={row.badge.tone} className="px-[9px] py-[3px] text-[12px]">
      {row.badge.label}
    </Badge>
  );
}

/** "Invoice" (downloads the PDF) or "View" (opens the order page with a full page load). */
export function OrderAction({ row }: { row: Pick<AccountOrderRow, "id" | "invoiceNumber" | "invoicePdfHref"> }) {
  const action = orderRowAction(row);
  const [busy, setBusy] = React.useState(false);
  if (action.kind === "view") {
    return (
      <a href={action.href} aria-label={action.ariaLabel} className={cn(buttonVariants({ variant: "secondary", size: "sm" }), ACTION)}>
        <Icon name={action.icon} size={16} />
        {action.label}
      </a>
    );
  }
  const download = async () => {
    setBusy(true);
    try {
      await downloadFile(action.href, action.fileName);
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : ORDERS_COPY.invoiceFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button type="button" variant="secondary" size="sm" loading={busy} aria-label={action.ariaLabel} onClick={download} className={ACTION}>
      {busy ? null : <Icon name={action.icon} size={16} />}
      {action.label}
    </Button>
  );
}

const col = createColumnHelper<AccountOrderRow>();

/**
 * Prototype columns: ORDER (mono, not sortable), DATE (sortable), ITEMS (+ "by …"), STATUS (sortable), INVOICE (mono),
 * TOTAL (right, sortable, "incl. ₹x GST"), then the row action. Sorting is done by the server (display columns with
 * enableSorting); a newly sorted column starts descending (table sortDescFirst).
 */
export const ORDER_COLUMNS = [
  col.display({
    id: "id",
    header: "Order",
    meta: { rowHeader: true, className: cn(PAD, "whitespace-nowrap"), headerClassName: PAD },
    cell: ({ row }) => (
      <a href={orderHref(row.original)} className={ID_LINK}>
        {row.original.id}
      </a>
    ),
  }),
  col.display({
    id: "date",
    header: "Date",
    enableSorting: true,
    meta: {
      className: cn(PAD, "whitespace-nowrap font-semibold"),
      headerClassName: PAD,
      sortLabels: { asc: "oldest first", desc: "newest first" },
    },
    cell: ({ row }) => orderDateLabel(row.original),
  }),
  col.display({
    id: "items",
    header: "Items",
    meta: { className: cn(PAD, "min-w-[200px] font-bold"), headerClassName: PAD },
    cell: ({ row }) => (
      <>
        {row.original.summary}
        <span className={SUB}>{row.original.placedByLabel}</span>
      </>
    ),
  }),
  col.display({
    id: "status",
    header: "Status",
    enableSorting: true,
    meta: { className: PAD, headerClassName: PAD },
    cell: ({ row }) => <OrderStatusPill row={row.original} />,
  }),
  col.display({
    id: "invoice",
    header: "Invoice",
    meta: { className: cn(PAD, "whitespace-nowrap font-mono text-[12.5px] text-ink-2"), headerClassName: PAD },
    cell: ({ row }) => orderInvoiceLabel(row.original),
  }),
  col.display({
    id: "total",
    header: "Total",
    enableSorting: true,
    meta: { align: "right", className: cn(PAD, "whitespace-nowrap font-extrabold"), headerClassName: PAD },
    cell: ({ row }) => (
      <>
        {orderTotalLabel(row.original)}
        <span className={SUB}>{orderTaxLabel(row.original)}</span>
      </>
    ),
  }),
  col.display({
    id: "actions",
    meta: { srLabel: ORDERS_COPY.actionsHeader, align: "right", className: cn(PAD, "whitespace-nowrap"), headerClassName: PAD },
    cell: ({ row }) => <OrderAction row={row.original} />,
  }),
];

/**
 * Card for one order below 760px (README: tables become cards; the prototype only scrolled this table sideways).
 * Module-level so the DataTable can memoise the cards.
 */
export function orderCard(row: AccountOrderRow): React.ReactNode {
  return (
    <>
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <a href={orderHref(row)} className={cn(ID_LINK, "text-[13.5px] font-bold")}>
            {row.id}
          </a>
          <span className="mt-0.5 block text-[12.5px] font-semibold text-ink-2">
            {orderDateLabel(row)}
            {row.invoiceNumber ? (
              <>
                {" · "}
                <span className="font-mono text-[12px]">{row.invoiceNumber}</span>
              </>
            ) : null}
          </span>
        </div>
        <OrderStatusPill row={row} />
      </div>
      <p className="m-0 text-[13.5px] font-bold">
        {row.summary}
        <span className={SUB}>{row.placedByLabel}</span>
      </p>
      <div className="flex flex-wrap items-end justify-between gap-2.5">
        <p className="m-0 text-[14px] font-extrabold">
          {orderTotalLabel(row)}
          <span className={SUB}>{orderTaxLabel(row)}</span>
        </p>
        <OrderAction row={row} />
      </div>
    </>
  );
}
