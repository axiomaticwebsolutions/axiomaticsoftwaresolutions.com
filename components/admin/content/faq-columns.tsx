"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { AdminCardContent } from "@/components/admin/admin-card";
import { StatusBadge } from "@/components/admin/status-badge";
import { faqExcerpt, type FaqDto } from "@/lib/admin/content/model";

/** QUESTION (question + answer excerpt) | PAGE | POSITION | STATUS (prototype, plus the position on its page). */
export const FAQ_COLUMNS: ColumnDef<FaqDto>[] = [
  {
    id: "question",
    header: "Question",
    accessorFn: (f) => f.question,
    cell: ({ row }) => (
      <>
        <div className="font-bold">{row.original.question}</div>
        <div className="mt-px text-[11.5px] font-semibold text-ink-2">{faqExcerpt(row.original.answer)}</div>
      </>
    ),
    meta: { rowHeader: true, className: "min-w-[280px]" },
  },
  { id: "page", header: "Page", accessorFn: (f) => f.pageLabel, cell: ({ row }) => row.original.pageLabel, meta: { className: "whitespace-nowrap" } },
  {
    id: "order",
    header: "Position",
    accessorFn: (f) => f.position,
    cell: ({ row }) => `${row.original.position} of ${row.original.pageCount}`,
    meta: { className: "whitespace-nowrap text-ink-2", sortLabels: { asc: "page order", desc: "reverse page order" } },
  },
  {
    id: "status",
    header: "Status",
    enableSorting: false,
    cell: ({ row }) => <StatusBadge kind="faq" status={row.original.status} />,
  },
];

export function faqCard(f: FaqDto): React.ReactNode {
  return (
    <AdminCardContent
      title={f.question}
      subtitle={`${f.pageLabel} · ${f.position} of ${f.pageCount}`}
      badge={<StatusBadge kind="faq" status={f.status} />}
    />
  );
}
