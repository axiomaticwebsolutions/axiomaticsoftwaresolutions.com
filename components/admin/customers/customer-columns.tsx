"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { AdminCardContent } from "@/components/admin/admin-card";
import { TwoLine } from "@/components/admin/licenses/cells";
import { Badge } from "@/components/ui/badge";
import { emailBadge, type AdminCustomerRow } from "@/lib/admin/customers/model";
import { formatINR } from "@/lib/money";

const col = createColumnHelper<AdminCustomerRow>();

export function EmailBadge({ verified }: { verified: boolean | null }) {
  const badge = emailBadge(verified);
  return (
    <Badge tone={badge.tone} size="sm" className="leading-[normal]">
      {badge.label}
    </Badge>
  );
}

/** Customers table (Admin Console.dc.html mods.customers cols): one row per business account, person first. */
export const CUSTOMER_COLUMNS = [
  col.accessor((r) => r.ownerName ?? r.legalName, {
    id: "name",
    header: "Customer",
    meta: { rowHeader: true, className: "whitespace-nowrap", sortLabels: { asc: "A to Z", desc: "Z to A" } },
    cell: ({ row }) => <TwoLine strong title={row.original.ownerName ?? row.original.legalName} sub={row.original.ownerEmail ?? "No owner"} />,
  }),
  col.accessor("legalName", {
    id: "business",
    header: "Business",
    meta: { className: "whitespace-nowrap", sortLabels: { asc: "A to Z", desc: "Z to A" } },
    cell: ({ row }) => <TwoLine title={row.original.legalName} sub={row.original.gstin ?? "No GSTIN"} />,
  }),
  col.accessor("state", {
    id: "state",
    header: "State",
    meta: { className: "whitespace-nowrap font-semibold", sortLabels: { asc: "A to Z", desc: "Z to A" } },
    cell: ({ row }) => row.original.state ?? "\u2014",
  }),
  col.accessor("activeLicenses", { id: "licenses", header: "Active licenses", meta: { align: "right", className: "tabular font-semibold" } }),
  col.accessor("orders", { id: "orders", header: "Orders", meta: { align: "right", className: "tabular font-semibold" } }),
  col.accessor("lifetimeValuePaise", {
    id: "ltv",
    header: "Lifetime value",
    meta: { align: "right", className: "whitespace-nowrap tabular font-semibold" },
    cell: ({ row }) => formatINR(row.original.lifetimeValuePaise),
  }),
  col.accessor("ownerVerified", {
    id: "email",
    header: "Email",
    enableSorting: false,
    cell: ({ row }) => <EmailBadge verified={row.original.ownerVerified} />,
  }),
];

/** Card below 760px (prototype mobile: name, "{business} · {LTV}", email badge). */
export function customerCard(row: AdminCustomerRow) {
  return (
    <AdminCardContent
      title={row.ownerName ?? row.legalName}
      subtitle={`${row.legalName} \u00B7 ${formatINR(row.lifetimeValuePaise)}`}
      badge={<EmailBadge verified={row.ownerVerified} />}
    />
  );
}
