import type * as React from "react";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { cn } from "@/lib/utils";

export type ReportColumn<T> = {
  key: string;
  header: React.ReactNode;
  /** Plain label for the phone cards when the header is not plain text. */
  label?: string;
  align?: "left" | "right";
  cell: (row: T) => React.ReactNode;
};

export type ReportTableProps<T> = {
  /** Names the table (visually hidden caption). */
  caption: string;
  columns: readonly ReportColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Totals row (tfoot; the last card on phones). */
  footer?: T;
  /** Shown instead of the table when there are no rows. */
  empty?: React.ReactNode;
  className?: string;
};

const TH = "whitespace-nowrap px-2.5 py-[9px] text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink-2";
const TD = "px-2.5 py-2.5 align-top tabular-nums";
const EDGE = "first:pl-4 last:pr-4";

/**
 * A report table (the admin panels' table look: 11px/800 headers, 13px rows on hairlines, numbers right-aligned) that
 * becomes one card per row below 760px, like the module tables. The first column names the row (row header). The
 * desktop table scrolls sideways inside its panel if the panel is narrower than the columns. Server-safe.
 */
export function ReportTable<T>({ caption, columns, rows, rowKey, footer, empty, className }: ReportTableProps<T>) {
  if (rows.length === 0 && empty) return <p className="m-0 p-4 text-[13px] text-ink-2">{empty}</p>;
  const [first, ...rest] = columns;
  if (!first) return null;
  const align = (c: ReportColumn<T>) => (c.align === "right" ? "text-right" : "text-left");
  const line = (row: T, total: boolean) => (
    <>
      <th scope="row" className={cn(TD, EDGE, "whitespace-nowrap text-left", total ? "font-extrabold" : "font-bold")}>
        {first.cell(row)}
      </th>
      {rest.map((c) => (
        <td key={c.key} className={cn(TD, EDGE, align(c), total ? "font-extrabold" : "font-semibold")}>
          {c.cell(row)}
        </td>
      ))}
    </>
  );
  return (
    <div className={className}>
      <ScrollRegion label={caption} className="hidden cards:block">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn(TH, EDGE, align(c))}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-t border-line-subtle">
                {line(row, false)}
              </tr>
            ))}
          </tbody>
          {footer ? (
            <tfoot>
              <tr className="border-t border-line-alt bg-bg">{line(footer, true)}</tr>
            </tfoot>
          ) : null}
        </table>
      </ScrollRegion>
      <ul aria-label={caption} className="m-0 list-none p-0 cards:hidden">
        {[...rows.map((row) => ({ row, total: false })), ...(footer ? [{ row: footer, total: true }] : [])].map(({ row, total }) => (
          <li key={total ? "total" : rowKey(row)} className={cn("grid gap-1.5 border-t border-line-subtle px-4 py-3 first:border-t-0", total && "bg-bg")}>
            <div className="text-[14px] font-extrabold">{first.cell(row)}</div>
            <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12.5px]">
              {rest.map((c) => (
                <div key={c.key} className="min-w-0">
                  <dt className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink-2">{c.label ?? c.header}</dt>
                  <dd className="m-0 font-bold tabular-nums">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
