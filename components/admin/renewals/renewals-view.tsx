"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { AdminBulkAction, AdminTable } from "@/components/admin/admin-table";
import { adminToast } from "@/components/admin/admin-toaster";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { DataTableEmptyState, EmptyStateAction } from "@/components/data-table";
import { useListState } from "@/components/data-table/use-list-state";
import { exportListCsv } from "@/components/admin/licenses/export-csv";
import { LicenseDrawer } from "@/components/admin/licenses/license-drawer";
import { apiFetch } from "@/lib/client/api";
import {
  REMIND_MAX_LICENSES,
  RENEWAL_COPY,
  RENEWAL_WINDOW_OPTIONS,
  RENEWALS_LIST,
  RENEWALS_SEARCH_PLACEHOLDER,
  type AdminRenewalRow,
  type RemindResult,
} from "@/lib/admin/renewals/model";
import { RENEWAL_COLUMNS, renewalCard } from "./renewal-columns";

export type RenewalsViewProps = { data: { items: AdminRenewalRow[]; total: number } | null };

const getRowId = (row: AdminRenewalRow) => row.id;
const getRowLabel = (row: AdminRenewalRow) => `${row.id}, ${row.customerName}`;

/** Sends "Send reminder now" for the ids; toasts "{n} reminders queued · {m} skipped" (or the one skip reason). */
async function sendReminders(ids: readonly string[]): Promise<boolean> {
  try {
    const result = await apiFetch<RemindResult>("/api/admin/renewals/remind", { method: "POST", body: { licenseIds: ids } });
    if (result.queued.length === 0 && result.skipped.length === 1) adminToast.error(null, `Not sent: ${result.skipped[0]?.reason ?? ""}`);
    else adminToast.success(RENEWAL_COPY.queued(result));
    return result.queued.length > 0;
  } catch (error) {
    adminToast.error(error);
    return false;
  }
}

/** Renewals & maintenance (Admin Console.dc.html mods.renewals): table, bulk reminders and the license drawer. */
export function RenewalsView({ data }: RenewalsViewProps) {
  const router = useRouter();
  const list = useListState(RENEWALS_LIST);
  const drawer = useDrawerParam();
  const rows = React.useMemo(() => data?.items ?? [], [data]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [sending, setSending] = React.useState(false);
  const refresh = React.useCallback(() => router.refresh(), [router]);
  const visible = React.useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selection = selected.filter((id) => visible.has(id)).slice(0, REMIND_MAX_LICENSES);

  const remindSelected = async () => {
    if (sending || selection.length === 0) return;
    setSending(true);
    if (await sendReminders(selection)) {
      setSelected([]);
      refresh();
    }
    setSending(false);
  };

  return (
    <>
      <AdminTable
        caption="Renewals"
        columns={RENEWAL_COLUMNS}
        data={rows}
        getRowId={getRowId}
        getRowLabel={getRowLabel}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        minWidth={880}
        loading={list.isPending}
        mobileCard={renewalCard}
        onRowClick={(row) => drawer.open(row.id)}
        exportPerm="reports.export"
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: RENEWALS_SEARCH_PLACEHOLDER, label: "Search renewals" },
          filters: [
            { id: "window", label: "Window", options: RENEWAL_WINDOW_OPTIONS, value: list.state.filters.window, onChange: (v) => list.setFilter("window", v) },
          ],
          onClear: list.clear,
          csv: { fileName: "renewals.csv", onExport: () => exportListCsv("/api/admin/renewals/export.csv", list.applied, RENEWALS_LIST, "renewals.csv") },
        }}
        pagination={{ page: list.applied.page, pageSize: list.applied.pageSize, total: data?.total ?? 0, onPageChange: list.setPage, pageHref: list.pageHref }}
        selection={{
          selected: selection,
          onChange: setSelected,
          bulkActions: (
            <AdminBulkAction perm="renewals.remind" aria-busy={sending || undefined} onClick={remindSelected}>
              {RENEWAL_COPY.remind}
            </AdminBulkAction>
          ),
        }}
        errorState={
          data ? undefined : (
            <DataTableEmptyState tone="error" icon="error" action={<EmptyStateAction onClick={refresh}>Try again</EmptyStateAction>}>
              We couldn&rsquo;t load renewals. Try again in a moment.
            </DataTableEmptyState>
          )
        }
      />
      <LicenseDrawer
        id={drawer.id}
        open={drawer.isOpen}
        onOpenChange={drawer.onOpenChange}
        onChanged={refresh}
        footerExtra={(license, changed) =>
          license.expiresAt && license.status !== "revoked" && license.planType !== "TRIAL" ? (
            <RemindAction id={license.id} onSent={changed} />
          ) : null
        }
      />
    </>
  );
}

function RemindAction({ id, onSent }: { id: string; onSent: () => void }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <AdminAction
      perm="renewals.remind"
      size="sm"
      icon="mail"
      busy={busy}
      onClick={async () => {
        setBusy(true);
        if (await sendReminders([id])) onSent();
        setBusy(false);
      }}
    >
      {RENEWAL_COPY.remind}
    </AdminAction>
  );
}
