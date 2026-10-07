"use client";

import { BulkAction, DataTable, toolbarIsFiltered, type BulkActionProps, type DataTableProps } from "@/components/data-table";
import { useAdminOptional } from "@/components/admin/admin-context";
import { canExport, exportNeedsAllLabel, withSelectionReset, type ExportPerm } from "@/components/admin/admin-table-model";
import { NOT_ALLOWED_FOR_ROLE, type Permission } from "@/lib/rbac";

/**
 * DataTable props without `variant` (always admin) and without a table-level `sortDescFirst`: in the admin a newly
 * sorted column starts descending only when it is right-aligned (amounts, counts), as in the prototype; a column can
 * still set its own `sortDescFirst`.
 */
export type AdminTableProps<T> = Omit<DataTableProps<T>, "variant" | "sortDescFirst"> & {
  /**
   * CSV export needs this permission, or all of these (reports.export; audit.view for the audit log; reports.export
   * plus the module permission for FAQs, templates and leads): disabled with "Export needs ..." otherwise.
   */
  exportPerm?: ExportPerm;
  /** Number for the "{n} results" count (default pagination.total, else the rows given). Pass null to hide the count. */
  resultCount?: number | null;
  /** Message when there are no records at all (default "No records yet."); filtered lists say "Nothing matches...". */
  emptyMessage?: string;
};

/** "1 result" / "1,204 results" (prototype toolbar count). */
export function resultCountLabel(count: number): string {
  return `${count.toLocaleString("en-IN")} ${count === 1 ? "result" : "results"}`;
}

/**
 * The admin console's generic table host (Admin Console.dc.html `table()`): DataTable in its admin variant with the
 * prototype's defaults: toolbar result count, CSV gated by the export permission ("Export needs Owner / Finance"),
 * "Select all on this page" / "Clear selection", compact pagination ("Showing 1–10 of 58", "Page 1 of 6",
 * "0 records") and the empty messages. Everything stays overridable through the DataTable props. With a selection,
 * every filter change and Clear also clear the selection (prototype), so bulk actions never reach hidden rows.
 */
export function AdminTable<T>({ toolbar, pagination, selection, emptyState, exportPerm, resultCount, emptyMessage, ...props }: AdminTableProps<T>) {
  const admin = useAdminOptional();
  const count = resultCount === undefined ? (pagination?.total ?? props.data.length) : resultCount;
  const exportDenied = !!exportPerm && !!admin && !canExport(exportPerm, admin.can);
  const csv = toolbar?.csv && exportDenied && exportPerm ? { ...toolbar.csv, disabledReason: exportNeedsAllLabel(exportPerm) } : toolbar?.csv;
  const filtered = toolbar ? toolbarIsFiltered(toolbar) : false;
  // Unconditional: some views pass only the visible part of their selection (licenses, renewals).
  const clearSelection = () => selection?.onChange([]);
  const tools = toolbar && selection ? withSelectionReset(toolbar, clearSelection) : toolbar;
  return (
    <DataTable
      variant="admin"
      toolbar={tools ? { countLabel: count === null ? undefined : resultCountLabel(count), ...tools, csv } : undefined}
      pagination={pagination ? { style: "compact", emptyLabel: "0 records", ...pagination } : undefined}
      selection={selection ? { selectAllLabel: "Select all on this page", clearLabel: "Clear selection", ...selection } : undefined}
      emptyState={emptyState ?? (filtered ? "Nothing matches your search or filters." : (emptyMessage ?? "No records yet."))}
      {...props}
    />
  );
}

export type AdminBulkActionProps = Omit<BulkActionProps, "variant"> & {
  /** Permission the bulk action needs: without it the button is disabled with "Not allowed for your role". */
  perm?: Permission;
};

/** A bulk-bar button in the admin size, gated by a permission like the prototype's bulk actions. */
export function AdminBulkAction({ perm, disabledReason, ...props }: AdminBulkActionProps) {
  const admin = useAdminOptional();
  const denied = !!perm && !!admin && !admin.can(perm);
  return <BulkAction variant="admin" disabledReason={denied ? NOT_ALLOWED_FOR_ROLE : disabledReason} {...props} />;
}
