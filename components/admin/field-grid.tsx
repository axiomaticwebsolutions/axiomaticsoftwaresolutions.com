import type * as React from "react";
import { fieldGridLayout } from "@/components/admin/model";
import { cn } from "@/lib/utils";

export type AdminField = {
  label: string;
  /** Empty values (null, undefined, false, "") read as an em dash. */
  value: React.ReactNode;
  /** JetBrains Mono (ids, GSTINs, invoice numbers, masked keys). */
  mono?: boolean;
  /** Spans both columns (long text such as an address or a reason). */
  wide?: boolean;
};

export const EMPTY_VALUE = "\u2014";

function isEmpty(value: React.ReactNode): boolean {
  return value === null || value === undefined || value === false || (typeof value === "string" && value.trim() === "");
}

export type FieldGridProps = {
  fields: readonly AdminField[];
  className?: string;
  "aria-label"?: string;
};

/**
 * Drawer facts (prototype dl): a two-column grid in a bordered card (radius 12), each cell a small label
 * (11px/800) over its value (13.5px/700, mono when asked, an em dash when empty). Server-safe.
 */
export function FieldGrid({ fields, className, "aria-label": ariaLabel }: FieldGridProps) {
  if (fields.length === 0) return null;
  const cells = fieldGridLayout(fields);
  return (
    <dl aria-label={ariaLabel} className={cn("m-0 grid grid-cols-2 overflow-hidden rounded-12 border border-line-subtle", className)}>
      {fields.map((field, i) => (
        <div
          key={`${field.label}:${i}`}
          className={cn(
            "min-w-0 border-line-subtle px-3 py-2.5",
            field.wide && "col-span-2",
            !cells[i]?.right && "border-r",
            !cells[i]?.lastRow && "border-b",
          )}
        >
          <dt className="text-[11px] font-extrabold tracking-[0.06em] text-ink-2">{field.label}</dt>
          <dd className={cn("m-0 mt-0.5 break-words font-bold", field.mono ? "font-mono text-[13px]" : "text-[13.5px]")}>
            {isEmpty(field.value) ? EMPTY_VALUE : field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
