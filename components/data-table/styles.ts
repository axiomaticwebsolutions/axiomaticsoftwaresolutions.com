import type { DataTableVariant } from "@/components/data-table/types";

/**
 * Class names per variant, from Customer Portal.dc.html (licenses, devices, orders, activity tables) and the admin
 * console's generic table. Tokens only: #E3E6EE line-alt, #EEF0F5 line-subtle, #DDE2EA line-strong, #F8F9FC header
 * row -> bg, #F6F3FF / #DCD3FB bulk bar -> lavender soft / line, #FBFAFF row hover -> lavender-soft at 50%.
 */
type VariantStyles = {
  frame: string;
  toolbar: string;
  control: string;
  filterLabel: string;
  table: string;
  headRow: string;
  head: string;
  cell: string;
  edgeLeft: string;
  edgeRight: string;
  /** Selection column (th and td, after edgeLeft) and its checkbox size. */
  selectCell: string;
  selectCheckbox: "sm" | "md";
  bulkBar: string;
  bulkButton: string;
  footer: string;
  pageButton: string;
  empty: string;
  card: string;
  statGrid: string;
  stat: string;
  statLabel: string;
  statValue: string;
  csvButton: string;
};

export const VARIANT_STYLES: Record<DataTableVariant, VariantStyles> = {
  portal: {
    frame: "rounded-16 border border-line-alt bg-surface",
    toolbar: "gap-2 px-3.5 py-3",
    control: "h-[38px] rounded-10 text-[13.5px]",
    filterLabel: "text-[13px]",
    table: "text-[13.5px]",
    headRow: "text-[11.5px]",
    head: "px-3 py-2.5",
    cell: "px-3 py-3",
    edgeLeft: "pl-3.5",
    edgeRight: "pr-3.5",
    // Prototype: padding 10px 14px, width 36px, a 16px checkbox -> a 44px column.
    selectCell: "w-11 pr-3.5",
    selectCheckbox: "sm",
    bulkBar: "px-3.5 py-2.5 text-[13.5px]",
    bulkButton: "h-auto rounded-9 px-3 py-1.5 text-[13.5px]",
    footer: "px-3.5 py-2.5",
    pageButton: "rounded-8 px-2.5 py-[5px]",
    empty: "px-6 py-10 text-[14.5px]",
    card: "p-3.5",
    statGrid: "grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-3",
    stat: "rounded-14 px-4 py-3.5",
    statLabel: "text-[11.5px] tracking-[0.06em]",
    statValue: "mt-1 text-[22px]",
    csvButton: "h-[38px] rounded-10 px-3 text-[13.5px]",
  },
  admin: {
    frame: "rounded-14 border border-line-alt bg-surface",
    toolbar: "gap-2 px-3 py-2.5",
    control: "h-[34px] rounded-8 text-[13px]",
    filterLabel: "text-[12.5px]",
    table: "text-[13px]",
    headRow: "text-[11px]",
    head: "px-2.5 py-[9px]",
    cell: "px-2.5 py-2.5",
    edgeLeft: "pl-3",
    edgeRight: "pr-3",
    selectCell: "w-9 pr-0",
    selectCheckbox: "md",
    bulkBar: "px-3 py-2 text-[13px]",
    bulkButton: "h-auto rounded-8 px-[11px] py-[5px] text-[13px]",
    footer: "px-3 py-[9px]",
    pageButton: "rounded-8 px-2 py-[5px]",
    empty: "px-6 py-10 text-[14px]",
    card: "p-3",
    statGrid: "grid-cols-[repeat(auto-fit,minmax(min(100%,170px),1fr))] gap-2.5",
    stat: "rounded-12 px-3.5 py-3",
    statLabel: "text-[11px] tracking-[0.07em]",
    statValue: "mt-[3px] text-[20px]",
    csvButton: "h-[34px] rounded-8 px-[11px] text-[13px]",
  },
};

export function alignClass(align: "left" | "center" | "right" | undefined): string {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
}
