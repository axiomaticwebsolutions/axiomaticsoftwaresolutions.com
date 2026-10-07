"use client";

import * as React from "react";
import Link from "next/link";
import { createColumnHelper } from "@tanstack/react-table";
import { PermissionAction } from "@/components/account/disabled-action";
import { orderPath, PORTAL_PATHS } from "@/components/account/portal-nav";
import { DataTable } from "@/components/data-table";
import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  BILLING_COPY,
  contactKey,
  PAYMENT_CSV_COLUMNS,
  paymentAmountLabel,
  paymentDateLabel,
  paymentMethodLabel,
  PAYMENTS_CSV_FILE_NAME,
  paymentsTruncatedLabel,
  type InvoiceContact,
  type PaymentHistoryRow,
} from "./billing-model";

const CARD = "min-w-0 rounded-16 border border-line-alt bg-surface px-[18px] py-4";
const H2 = "m-0 text-[15px] font-extrabold";
const MONO = "font-mono text-[12.5px]";
const ORDER_LINK = "rounded-6 text-ink no-underline hover:text-ink hover:underline";

/** "Invoice delivery": ACTIVE Owner and Billing admin members (read-only; managed in Team & access, Owner only). */
export function InvoiceContactsCard({ contacts }: { contacts: readonly InvoiceContact[] }) {
  const titleId = React.useId();
  return (
    <section aria-labelledby={titleId} className={CARD}>
      <h2 id={titleId} className={H2}>
        {BILLING_COPY.contactsTitle}
      </h2>
      <p className="mb-0 mt-1 text-[13px] text-ink-2">{BILLING_COPY.contactsDescription}</p>
      {contacts.length > 0 ? (
        <ul className="m-0 mt-3 grid list-none gap-2 p-0">
          {contacts.map((contact) => (
            <li
              key={contactKey(contact)}
              className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-10 bg-bg px-3 py-2.5 text-[13.5px]"
            >
              <Icon name="mail" size={18} className="shrink-0 text-ink-2" />
              {/* Content-width basis keeps the email whole on phones (the role label wraps to its own line); the cap
                  keeps a very long address beside the icon, where it may break. */}
              <span className="min-w-0 max-w-[calc(100%_-_28px)] flex-auto font-bold [overflow-wrap:anywhere]">{contact.email}</span>
              <span className="ml-auto text-[12px] font-bold text-ink-2">{contact.roleLabel}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-0 mt-3 text-[13.5px] text-ink-2">{BILLING_COPY.contactsEmpty}</p>
      )}
      <PermissionAction perm="team.manage">
        <Link
          href={PORTAL_PATHS.team}
          className="mt-2.5 inline-block rounded-6 text-[13.5px] font-bold text-primary-link underline underline-offset-2 hover:text-primary-link-hover"
        >
          {BILLING_COPY.manageTeam}
        </Link>
      </PermissionAction>
    </section>
  );
}

/** "Payment methods": nothing is stored and nothing renews automatically (decisions.md rule 2). */
export function PaymentMethodsCard() {
  const titleId = React.useId();
  return (
    <section aria-labelledby={titleId} className={CARD}>
      <h2 id={titleId} className={H2}>
        {BILLING_COPY.methodsTitle}
      </h2>
      <p className="mb-0 mt-1.5 text-[13.5px] leading-[1.55] text-ink-2">{BILLING_COPY.methodsBody}</p>
    </section>
  );
}

function PaymentStatusPill({ row }: { row: Pick<PaymentHistoryRow, "badge"> }) {
  return (
    // An inline pill like the prototype's span (12px text, 3px padding): its padding does not grow the line box, so
    // rows stay 41px tall.
    <Badge tone={row.badge.tone} className="inline px-[9px] py-[3px] text-[12px]">
      {row.badge.label}
    </Badge>
  );
}

/** Order id as a full page load (the order page has its own CSP: decisions.md Phase 3 integration). */
function OrderLink({ id, className }: { id: string; className?: string }) {
  return (
    <a href={orderPath(id)} className={cn(ORDER_LINK, className)}>
      {id}
    </a>
  );
}

const col = createColumnHelper<PaymentHistoryRow>();

/** Prototype cell padding: 11px 12px, 18px at the outer edges (header 10px 18px). */
const CELL = "py-[11px]";
const EDGE_CELL = "px-[18px] py-[11px]";
const EDGE_HEAD = "px-[18px]";

/** Prototype columns: DATE, PAYMENT ID (mono), ORDER (mono), METHOD, STATUS, AMOUNT (right). Not sortable. */
const PAYMENT_COLUMNS = [
  col.display({
    id: "date",
    header: "Date",
    meta: { className: cn(EDGE_CELL, "whitespace-nowrap font-semibold"), headerClassName: EDGE_HEAD },
    cell: ({ row }) => paymentDateLabel(row.original),
  }),
  col.display({
    id: "reference",
    header: "Payment ID",
    meta: { className: cn(CELL, MONO, "text-ink-2 [overflow-wrap:anywhere]") },
    // Not every payment has a provider reference yet (e.g. a failed attempt before the provider replied).
    cell: ({ row }) => row.original.reference ?? "—",
  }),
  col.display({
    id: "order",
    header: "Order",
    // The order id names the row (<th scope="row">); it is always present, unlike the payment reference.
    meta: { rowHeader: true, className: cn(CELL, MONO, "whitespace-nowrap") },
    cell: ({ row }) => <OrderLink id={row.original.orderId} />,
  }),
  col.display({
    id: "method",
    header: "Method",
    meta: { className: cn(CELL, "font-semibold") },
    cell: ({ row }) => paymentMethodLabel(row.original),
  }),
  col.display({
    id: "status",
    header: "Status",
    meta: { className: CELL },
    cell: ({ row }) => <PaymentStatusPill row={row.original} />,
  }),
  col.display({
    id: "amount",
    header: "Amount",
    meta: { align: "right", className: cn(EDGE_CELL, "whitespace-nowrap font-extrabold"), headerClassName: EDGE_HEAD },
    cell: ({ row }) => paymentAmountLabel(row.original),
  }),
];

/** One payment below 760px (module level so the table can memoise the cards). */
function paymentCard(row: PaymentHistoryRow): React.ReactNode {
  return (
    <>
      <div className="flex items-start justify-between gap-2.5">
        <span className="text-[13.5px] font-semibold">{paymentDateLabel(row)}</span>
        <span className="whitespace-nowrap text-[14px] font-extrabold">{paymentAmountLabel(row)}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <span className="text-[13px] font-semibold text-ink-2">
          {row.method ? `${paymentMethodLabel(row)} · ` : null}
          <OrderLink id={row.orderId} className={MONO} />
        </span>
        <PaymentStatusPill row={row} />
      </div>
      <span className={cn(MONO, "block text-ink-2 [overflow-wrap:anywhere]")}>{row.reference ?? "—"}</span>
    </>
  );
}

const paymentRowId = (row: PaymentHistoryRow) => row.id;

/** "Payment history" with "Export CSV" (payments.csv, client-side from the listed rows). */
export function PaymentHistory({
  payments,
  truncated,
  className,
}: {
  payments: readonly PaymentHistoryRow[];
  truncated: boolean;
  className?: string;
}) {
  const titleId = React.useId();
  return (
    <section aria-labelledby={titleId} className={cn("min-w-0", className)}>
      <DataTable
        caption={BILLING_COPY.historyTitle}
        columns={PAYMENT_COLUMNS}
        data={payments}
        getRowId={paymentRowId}
        minWidth={640}
        mobileCard={paymentCard}
        toolbar={{
          controls: (
            // ml-1: the prototype's 18px toolbar inset (the table toolbar has 14px).
            <h2 id={titleId} className={cn(H2, "ml-1 mr-auto py-1.5")}>
              {BILLING_COPY.historyTitle}
            </h2>
          ),
          csv: { fileName: PAYMENTS_CSV_FILE_NAME, columns: PAYMENT_CSV_COLUMNS, label: BILLING_COPY.exportCsv },
        }}
        emptyState={BILLING_COPY.paymentsEmpty}
        footer={truncated ? paymentsTruncatedLabel(payments.length) : undefined}
      />
    </section>
  );
}
