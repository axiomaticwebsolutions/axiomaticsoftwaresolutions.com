"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { AdminBulkAction, AdminTable } from "@/components/admin/admin-table";
import { DestructiveAction } from "@/components/admin/destructive-action";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { useListState } from "@/components/data-table/use-list-state";
import { PLAN_TYPE_FILTERS, PLAN_TYPE_LABELS, planTypeFromFilter } from "@/lib/admin/catalog/model";
import { PLANS_LIST } from "@/lib/admin/catalog/list-config";
import type { AdminPlanRow, CatalogFormOptions } from "@/lib/admin/catalog/types";
import type { ListPage } from "@/lib/admin/list-query";
import { apiFetch } from "@/lib/client/api";
import { planCard, planColumns } from "./plan-columns";
import { NEW_PLAN_PARAM, PlanCreateDrawer } from "./plan-create";
import { PlanDrawer } from "./plan-drawer";
import { exportCsv, exportHref, filterOptions, useRefresh } from "./shared";

/** Header action "New plan" (pricing.manage). */
export function PlansActions() {
  const create = useDrawerParam(NEW_PLAN_PARAM);
  return (
    <AdminAction perm="pricing.manage" variant="primary" icon="add" onClick={() => create.open("plan")}>
      New plan
    </AdminAction>
  );
}

const TYPE_OPTIONS = filterOptions(PLAN_TYPE_FILTERS.map((t) => [t, PLAN_TYPE_LABELS[planTypeFromFilter(t) ?? "TRIAL"]] as const));
const STATUS_OPTIONS = filterOptions([
  ["on_sale", "On sale"],
  ["archived", "Archived"],
]);

type Props = {
  page: ListPage<AdminPlanRow>;
  options: CatalogFormOptions;
  gstRatePct: number;
  offlineGraceDays: number;
};

/**
 * Plans & license policies (Admin Console.dc.html #plans): plans grouped by product, Product / Type / Status filters,
 * bulk "Archive" (reason; one audit row per plan), the plan drawer (?id=) and "New plan" (?new=plan).
 */
export function PlansView({ page, options, gstRatePct, offlineGraceDays }: Props) {
  const list = useListState(PLANS_LIST);
  const drawer = useDrawerParam();
  const create = useDrawerParam(NEW_PLAN_PARAM);
  const { refresh, refreshing } = useRefresh();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [confirmBulk, setConfirmBulk] = React.useState(false);
  const columns = React.useMemo(() => planColumns(gstRatePct), [gstRatePct]);
  const productOptions = React.useMemo(() => filterOptions(options.products.map((p) => [p.id, p.name] as const)), [options.products]);
  const setFilter = (key: "product" | "type" | "status", value: string) => {
    setSelected([]);
    list.setFilter(key, value);
  };

  async function archiveSelected(reason: string) {
    const res = await apiFetch<{ archived: string[]; skipped: string[] }>("/api/admin/plans/bulk-archive", { method: "POST", body: { ids: selected, reason } });
    setSelected([]);
    refresh();
    return res;
  }

  const productFilter = list.state.filters.product;
  return (
    <>
      <AdminTable
        caption="Plans"
        columns={columns}
        data={page.items}
        getRowId={(p) => p.id}
        getRowLabel={(p) => `${p.productName} \u00B7 ${p.name}`}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        manual
        loading={list.isPending || refreshing}
        minWidth={980}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: "Search plans", label: "Search plans" },
          filters: [
            { id: "product", label: "Product", options: productOptions, value: productFilter, onChange: (v) => setFilter("product", v) },
            { id: "type", label: "Type", options: TYPE_OPTIONS, value: list.state.filters.type, onChange: (v) => setFilter("type", v) },
            { id: "status", label: "Status", options: STATUS_OPTIONS, value: list.state.filters.status, onChange: (v) => setFilter("status", v) },
          ],
          onClear: () => {
            setSelected([]);
            list.clear();
          },
          csv: { fileName: "plans.csv", onExport: () => exportCsv(exportHref("/api/admin/plans/export.csv", list.state, PLANS_LIST), "plans.csv") },
        }}
        exportPerm="reports.export"
        resultCount={page.total}
        selection={{
          selected,
          onChange: setSelected,
          bulkActions: (
            <AdminBulkAction perm="pricing.manage" tone="danger" onClick={() => setConfirmBulk(true)}>
              Archive
            </AdminBulkAction>
          ),
        }}
        pagination={{ page: page.page, pageSize: page.pageSize, total: page.total, onPageChange: list.setPage, pageHref: list.pageHref }}
        onRowClick={(p) => drawer.open(p.id)}
        mobileCard={planCard}
        emptyMessage="No plans yet."
      />
      <DestructiveAction
        actionKey="plans.archive"
        targetId="selected"
        hideTrigger
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={`Archive ${selected.length} ${selected.length === 1 ? "plan" : "plans"}?`}
        confirmLabel="Archive"
        consequence={"Archived plans can\u2019t be bought. Existing licenses keep working and can still renew."}
        successMessage="Plans archived"
        onConfirm={({ reason }) => archiveSelected(reason)}
      />
      <PlanDrawer
        id={drawer.id}
        open={drawer.isOpen}
        onOpenChange={drawer.onOpenChange}
        gstRatePct={gstRatePct}
        offlineGraceDays={offlineGraceDays}
        onChanged={refresh}
      />
      <PlanCreateDrawer
        open={create.isOpen && !drawer.isOpen}
        onOpenChange={create.onOpenChange}
        options={options}
        productId={productFilter !== "all" ? productFilter : undefined}
        onCreated={refresh}
      />
    </>
  );
}
