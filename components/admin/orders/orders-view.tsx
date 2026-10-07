"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminBulkAction, AdminTable } from "@/components/admin/admin-table";
import { adminToast } from "@/components/admin/admin-toaster";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { DataTableEmptyState, EmptyStateAction } from "@/components/data-table";
import { useListState } from "@/components/data-table/use-list-state";
import {
  ADMIN_ORDERS_LIST,
  COUPON_FILTER_ANY,
  COUPON_FILTER_NONE,
  exportToast,
  ORDER_DATE_FILTERS,
  ORDER_DATE_LABELS,
  ORDER_METHOD_FILTERS,
  ORDER_METHOD_LABELS,
  ORDER_STATUS_FILTER_LABELS,
  ORDER_STATUS_FILTERS,
  ORDERS_COPY,
  ORDERS_RESEND_BULK_PATH,
  ordersExportHref,
  PROVIDER_LABELS,
  resendToast,
  type AdminOrderFilterOptions,
  type AdminOrderList,
  type AdminOrderRow,
  type OrderFilterKey,
  type ResendResponse,
} from "@/lib/admin/orders/model";
import { apiFetch } from "@/lib/client/api";
import { isListFiltered } from "@/lib/url-state";
import { downloadAdminCsv } from "./download";
import { OrderDrawer } from "./order-drawer";
import { ORDER_COLUMNS, orderCard } from "./order-columns";

export type OrdersViewProps = {
  /** The page of orders for the URL state, or null when loading failed. */
  list: AdminOrderList | null;
  options: AdminOrderFilterOptions;
};

const getRowId = (row: AdminOrderRow) => row.id;
const ALL = { value: "all", label: "All" };
/** Flex basis of the toolbar search, wide enough for ORDERS_COPY.searchPlaceholder. */
const ORDERS_SEARCH_CLASS = "flex-[1_1_340px]";

/** Orders table (Admin Console.dc.html #orders): URL-synced list, filters, CSV, bulk bar and the order drawer. */
export function OrdersView({ list: data, options }: OrdersViewProps) {
  const router = useRouter();
  const list = useListState(ADMIN_ORDERS_LIST);
  const drawer = useDrawerParam();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState<"csv" | "selected" | "resend" | null>(null);
  const filtered = isListFiltered(list.applied, ADMIN_ORDERS_LIST);

  const filter = (id: OrderFilterKey, label: string, opts: readonly { value: string; label: string }[], allLabel = "All") => ({
    id,
    label,
    options: [{ ...ALL, label: allLabel }, ...opts],
    value: list.state.filters[id] ?? "all",
    onChange: (value: string) => list.setFilter(id, value),
  });

  const filters = [
    filter("status", "Status", ORDER_STATUS_FILTERS.map((v) => ({ value: v, label: ORDER_STATUS_FILTER_LABELS[v] }))),
    filter("method", "Method", ORDER_METHOD_FILTERS.map((v) => ({ value: v, label: ORDER_METHOD_LABELS[v] }))),
    filter("product", "Product", options.products),
    filter("date", "Date", ORDER_DATE_FILTERS.map((v) => ({ value: v, label: ORDER_DATE_LABELS[v] })), "All time"),
    filter("coupon", "Coupon", [
      { value: COUPON_FILTER_ANY, label: "Any coupon" },
      { value: COUPON_FILTER_NONE, label: "No coupon" },
      ...options.coupons.map((c) => ({ value: c, label: c })),
    ]),
    filter("provider", "Provider", options.providers.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))),
  ];

  const download = async (kind: "csv" | "selected") => {
    if (busy) return;
    setBusy(kind);
    try {
      const ids = kind === "selected" ? selected : undefined;
      const fallback = kind === "selected" ? ORDERS_COPY.selectedCsvFileName : ORDERS_COPY.csvFileName;
      const result = await downloadAdminCsv(ordersExportHref(list.applied, ids), fallback);
      adminToast.success(exportToast(result.rows ?? 0, result.fileName, result.truncated));
    } catch (error) {
      adminToast.error(error);
    } finally {
      setBusy(null);
    }
  };

  const resendSelected = async () => {
    if (busy || selected.length === 0) return;
    setBusy("resend");
    try {
      const result = await apiFetch<ResendResponse>(ORDERS_RESEND_BULK_PATH, { method: "POST", body: { ids: selected } });
      adminToast.success(resendToast(result));
      setSelected([]);
    } catch (error) {
      adminToast.error(error);
    } finally {
      setBusy(null);
    }
  };

  // Filter changes and the toolbar's Clear also clear the selection (AdminTable); so does this Clear.
  const clearAll = () => {
    setSelected([]);
    list.clear();
  };

  const emptyState = filtered ? (
    <DataTableEmptyState variant="admin" action={<EmptyStateAction clearsFilters onClick={clearAll}>Clear filters</EmptyStateAction>}>
      Nothing matches your search or filters.
    </DataTableEmptyState>
  ) : (
    ORDERS_COPY.emptyNone
  );

  return (
    <>
      <AdminTable
        caption={ORDERS_COPY.caption}
        columns={ORDER_COLUMNS}
        data={data?.items ?? []}
        getRowId={getRowId}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        minWidth={980}
        loading={list.isPending}
        exportPerm="reports.export"
        resultCount={data?.total ?? 0}
        onRowClick={(row) => drawer.open(row.id)}
        mobileCard={orderCard}
        toolbar={{
          search: {
            value: list.state.q,
            onChange: list.setQuery,
            placeholder: ORDERS_COPY.searchPlaceholder,
            label: ORDERS_COPY.searchLabel,
            // Six filters: a wider search keeps "…email or payment ID" in view and moves the filters to the next row.
            className: ORDERS_SEARCH_CLASS,
          },
          filters,
          onClear: list.clear,
          csv: { fileName: ORDERS_COPY.csvFileName, onExport: () => download("csv") },
        }}
        selection={{
          selected,
          onChange: setSelected,
          bulkActions: (
            <>
              <AdminBulkAction perm="orders.resend_invoice" onClick={resendSelected} disabled={busy === "resend"}>
                {ORDERS_COPY.resendInvoices}
              </AdminBulkAction>
              <AdminBulkAction perm="reports.export" onClick={() => download("selected")} disabled={busy === "selected"}>
                {ORDERS_COPY.exportSelected}
              </AdminBulkAction>
            </>
          ),
        }}
        pagination={
          data
            ? { page: list.applied.page, pageSize: data.pageSize, total: data.total, onPageChange: list.setPage, pageHref: list.pageHref, label: "Orders pages" }
            : undefined
        }
        emptyState={emptyState}
        errorState={
          data ? undefined : (
            <DataTableEmptyState
              tone="error"
              variant="admin"
              action={<EmptyStateAction onClick={() => router.refresh()}>Try again</EmptyStateAction>}
            >
              {ORDERS_COPY.loadError}
            </DataTableEmptyState>
          )
        }
      />
      <OrderDrawer id={drawer.id} open={drawer.isOpen} onOpenChange={drawer.onOpenChange} onChanged={() => router.refresh()} />
    </>
  );
}
