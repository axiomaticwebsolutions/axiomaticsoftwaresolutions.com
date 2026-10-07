"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminBulkAction, AdminTable } from "@/components/admin/admin-table";
import { adminToast } from "@/components/admin/admin-toaster";
import { DestructiveAction } from "@/components/admin/destructive-action";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { DataTableEmptyState, EmptyStateAction } from "@/components/data-table";
import { useListState } from "@/components/data-table/use-list-state";
import { apiFetch } from "@/lib/client/api";
import {
  BULK_MAX_LICENSES,
  EXTEND_DEFAULT_DAYS,
  LICENSE_COPY,
  LICENSE_DEVICE_OPTIONS,
  LICENSE_STATUS_OPTIONS,
  LICENSE_TOASTS,
  LICENSES_LIST,
  LICENSES_SEARCH_PLACEHOLDER,
  type AdminLicenseRow,
  type AdminProductOption,
  type BulkLicenseResult,
} from "@/lib/admin/licenses/model";
import { withAll } from "@/lib/admin/licenses/list-state";
import { exportListCsv } from "./export-csv";
import { licenseCard, licenseColumns } from "./license-columns";
import { LicenseDrawer } from "./license-drawer";

export type LicensesViewProps = {
  /** One page for the URL state, or null when loading failed. */
  data: { items: AdminLicenseRow[]; total: number } | null;
  products: readonly AdminProductOption[];
  /** The server's time of the page (ISO): EXPIRES dates within the expiring window show amber. */
  nowIso: string;
};

const getRowId = (row: AdminLicenseRow) => row.id;
const getRowLabel = (row: AdminLicenseRow) => `${row.id}, ${row.customerName}`;

function bulkToast(base: string, result: BulkLicenseResult): string {
  return result.skipped.length > 0 ? `${base} \u00B7 ${result.skipped.length} skipped` : base;
}

/** Licenses (Admin Console.dc.html mods.licenses): server-paged, URL-synced table, bulk bar and the license drawer. */
export function LicensesView({ data, products, nowIso }: LicensesViewProps) {
  const columns = React.useMemo(() => licenseColumns(nowIso), [nowIso]);
  const router = useRouter();
  const list = useListState(LICENSES_LIST);
  const drawer = useDrawerParam();
  const rows = React.useMemo(() => data?.items ?? [], [data]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [bulk, setBulk] = React.useState<"extend" | "suspend" | null>(null);
  const refresh = React.useCallback(() => router.refresh(), [router]);

  // Bulk actions act on what is shown: keep only selected rows that are still on the page.
  const visible = React.useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selection = selected.filter((id) => visible.has(id)).slice(0, BULK_MAX_LICENSES);
  const n = selection.length;

  const runBulk = async (action: "extend" | "suspend", reason: string) => {
    const result = await apiFetch<BulkLicenseResult>("/api/admin/licenses/bulk", {
      method: "POST",
      body: { action, ids: selection, reason, ...(action === "extend" ? { days: EXTEND_DEFAULT_DAYS } : {}) },
    });
    setSelected([]);
    refresh();
    return result;
  };

  const productOptions = React.useMemo(() => withAll(products.map((p) => ({ value: p.id, label: p.shortName }))), [products]);

  return (
    <>
      <AdminTable
        caption="Licenses"
        columns={columns}
        data={rows}
        getRowId={getRowId}
        getRowLabel={getRowLabel}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        minWidth={960}
        loading={list.isPending}
        mobileCard={licenseCard}
        onRowClick={(row) => drawer.open(row.id)}
        exportPerm="reports.export"
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: LICENSES_SEARCH_PLACEHOLDER, label: "Search licenses" },
          filters: [
            { id: "status", label: "Status", options: LICENSE_STATUS_OPTIONS, value: list.state.filters.status, onChange: (v) => list.setFilter("status", v) },
            { id: "product", label: "Product", options: productOptions, value: list.state.filters.product, onChange: (v) => list.setFilter("product", v) },
            { id: "devices", label: "Devices", options: LICENSE_DEVICE_OPTIONS, value: list.state.filters.devices, onChange: (v) => list.setFilter("devices", v) },
          ],
          onClear: list.clear,
          csv: { fileName: "licenses.csv", onExport: () => exportListCsv("/api/admin/licenses/export.csv", list.applied, LICENSES_LIST, "licenses.csv") },
        }}
        pagination={{ page: list.applied.page, pageSize: list.applied.pageSize, total: data?.total ?? 0, onPageChange: list.setPage, pageHref: list.pageHref }}
        selection={{
          selected: selection,
          onChange: setSelected,
          bulkActions: (
            <>
              <AdminBulkAction perm="licenses.manage" onClick={() => setBulk("extend")}>
                Extend {EXTEND_DEFAULT_DAYS} days
              </AdminBulkAction>
              <AdminBulkAction perm="licenses.manage" tone="danger" onClick={() => setBulk("suspend")}>
                Suspend
              </AdminBulkAction>
            </>
          ),
        }}
        errorState={
          data ? undefined : (
            <DataTableEmptyState tone="error" icon="error" action={<EmptyStateAction onClick={refresh}>Try again</EmptyStateAction>}>
              We couldn&rsquo;t load licenses. Try again in a moment.
            </DataTableEmptyState>
          )
        }
      />
      <DestructiveAction
        hideTrigger
        open={bulk === "extend"}
        onOpenChange={(open) => (open ? undefined : setBulk(null))}
        actionKey="licenses.extend"
        targetId=""
        title={`Extend ${n} ${n === 1 ? "license" : "licenses"} by ${EXTEND_DEFAULT_DAYS} days?`}
        consequence={LICENSE_COPY.bulkExtend}
        onConfirm={async ({ reason }) => {
          const result = await runBulk("extend", reason);
          adminToast.success(bulkToast(LICENSE_TOASTS.bulkExtend, result));
        }}
      />
      <DestructiveAction
        hideTrigger
        open={bulk === "suspend"}
        onOpenChange={(open) => (open ? undefined : setBulk(null))}
        actionKey="licenses.suspend"
        targetId=""
        title={`Suspend ${n} ${n === 1 ? "license" : "licenses"}?`}
        consequence={LICENSE_COPY.bulkSuspend}
        tone="danger"
        onConfirm={async ({ reason }) => {
          const result = await runBulk("suspend", reason);
          adminToast.success(bulkToast(LICENSE_TOASTS.bulkSuspend, result));
        }}
      />
      <LicenseDrawer id={drawer.id} open={drawer.isOpen} onOpenChange={drawer.onOpenChange} onChanged={refresh} />
    </>
  );
}
