"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminTable } from "@/components/admin/admin-table";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { DataTableEmptyState, EmptyStateAction } from "@/components/data-table";
import { useListState } from "@/components/data-table/use-list-state";
import { exportListCsv } from "@/components/admin/licenses/export-csv";
import { CUSTOMER_GST_OPTIONS, CUSTOMERS_LIST, CUSTOMERS_SEARCH_PLACEHOLDER, type AdminCustomerRow } from "@/lib/admin/customers/model";
import { withAll } from "@/lib/admin/licenses/list-state";
import { CUSTOMER_COLUMNS, customerCard } from "./customer-columns";
import { CustomerDrawer } from "./customer-drawer";
import { NEW_CUSTOMER_PARAM, NewCustomerDrawer } from "./new-customer";

export type CustomersViewProps = {
  data: { items: AdminCustomerRow[]; total: number } | null;
  states: readonly string[];
};

const getRowId = (row: AdminCustomerRow) => row.id;
const getRowLabel = (row: AdminCustomerRow) => row.ownerName ? `${row.ownerName}, ${row.legalName}` : row.legalName;

/**
 * Customers & business accounts (Admin Console.dc.html mods.customers): server-paged table, the customer drawer (?id=)
 * and the "New customer" drawer (?new=1).
 */
export function CustomersView({ data, states }: CustomersViewProps) {
  const router = useRouter();
  const list = useListState(CUSTOMERS_LIST);
  const drawer = useDrawerParam();
  const create = useDrawerParam(NEW_CUSTOMER_PARAM);
  const refresh = React.useCallback(() => router.refresh(), [router]);
  const stateOptions = React.useMemo(() => withAll(states.map((s) => ({ value: s, label: s }))), [states]);
  return (
    <>
      <AdminTable
        caption="Customers"
        columns={CUSTOMER_COLUMNS}
        data={data?.items ?? []}
        getRowId={getRowId}
        getRowLabel={getRowLabel}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        minWidth={900}
        loading={list.isPending}
        mobileCard={customerCard}
        onRowClick={(row) => drawer.open(row.id)}
        exportPerm="reports.export"
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: CUSTOMERS_SEARCH_PLACEHOLDER, label: "Search customers" },
          filters: [
            { id: "gst", label: "GSTIN", options: CUSTOMER_GST_OPTIONS, value: list.state.filters.gst, onChange: (v) => list.setFilter("gst", v) },
            { id: "state", label: "State", options: stateOptions, value: list.state.filters.state, onChange: (v) => list.setFilter("state", v) },
          ],
          onClear: list.clear,
          csv: { fileName: "customers.csv", onExport: () => exportListCsv("/api/admin/customers/export.csv", list.applied, CUSTOMERS_LIST, "customers.csv") },
        }}
        pagination={{ page: list.applied.page, pageSize: list.applied.pageSize, total: data?.total ?? 0, onPageChange: list.setPage, pageHref: list.pageHref }}
        errorState={
          data ? undefined : (
            <DataTableEmptyState tone="error" icon="error" action={<EmptyStateAction onClick={() => router.refresh()}>Try again</EmptyStateAction>}>
              We couldn&rsquo;t load customers. Try again in a moment.
            </DataTableEmptyState>
          )
        }
      />
      <CustomerDrawer id={drawer.id} open={drawer.isOpen} onOpenChange={drawer.onOpenChange} onChanged={refresh} />
      <NewCustomerDrawer open={create.isOpen && !drawer.isOpen} onOpenChange={create.onOpenChange} onCreated={refresh} />
    </>
  );
}
