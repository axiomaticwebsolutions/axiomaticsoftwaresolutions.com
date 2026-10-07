"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { AdminTable } from "@/components/admin/admin-table";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { useListState } from "@/components/data-table/use-list-state";
import { RELEASES_LIST } from "@/lib/admin/catalog/list-config";
import type { AdminReleaseRow, CatalogFormOptions } from "@/lib/admin/catalog/types";
import type { ListPage } from "@/lib/admin/list-query";
import { RELEASE_COLUMNS, releaseCard } from "./release-columns";
import { NEW_RELEASE_PARAM, ReleaseCreateDrawer } from "./release-create";
import { ReleaseDrawer } from "./release-drawer";
import { exportCsv, exportHref, filterOptions, useRefresh } from "./shared";

/** Header action "New release" (releases.manage). */
export function ReleasesActions() {
  const create = useDrawerParam(NEW_RELEASE_PARAM);
  return (
    <AdminAction perm="releases.manage" variant="primary" icon="upload" onClick={() => create.open("release")}>
      New release
    </AdminAction>
  );
}

const STATUS_OPTIONS = filterOptions([
  ["latest", "Latest"],
  ["published", "Published"],
  ["draft", "Draft"],
  ["withdrawn", "Withdrawn"],
]);

type Props = { page: ListPage<AdminReleaseRow>; options: CatalogFormOptions; linkMinutes: number };

/** Software releases (Admin Console.dc.html #releases): newest first, Product / Status filters, drawer, "New release". */
export function ReleasesView({ page, options, linkMinutes }: Props) {
  const list = useListState(RELEASES_LIST);
  const drawer = useDrawerParam();
  const create = useDrawerParam(NEW_RELEASE_PARAM);
  const { refresh, refreshing } = useRefresh();
  const productOptions = React.useMemo(() => filterOptions(options.products.map((p) => [p.id, p.name] as const)), [options.products]);
  const productFilter = list.state.filters.product;

  return (
    <>
      <AdminTable
        caption="Software releases"
        columns={RELEASE_COLUMNS}
        data={page.items}
        getRowId={(r) => r.id}
        getRowLabel={(r) => `${r.productName} v${r.version}`}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        manual
        loading={list.isPending || refreshing}
        minWidth={900}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: "Search releases", label: "Search releases" },
          filters: [
            { id: "product", label: "Product", options: productOptions, value: productFilter, onChange: (v) => list.setFilter("product", v) },
            { id: "status", label: "Status", options: STATUS_OPTIONS, value: list.state.filters.status, onChange: (v) => list.setFilter("status", v) },
          ],
          onClear: list.clear,
          csv: { fileName: "releases.csv", onExport: () => exportCsv(exportHref("/api/admin/releases/export.csv", list.state, RELEASES_LIST), "releases.csv") },
        }}
        exportPerm="reports.export"
        resultCount={page.total}
        pagination={{ page: page.page, pageSize: page.pageSize, total: page.total, onPageChange: list.setPage, pageHref: list.pageHref }}
        onRowClick={(r) => drawer.open(r.id)}
        mobileCard={releaseCard}
        emptyMessage="No releases yet."
      />
      <ReleaseDrawer id={drawer.id} open={drawer.isOpen} onOpenChange={drawer.onOpenChange} linkMinutes={linkMinutes} onChanged={refresh} onDeleted={drawer.close} />
      <ReleaseCreateDrawer
        open={create.isOpen && !drawer.isOpen}
        onOpenChange={create.onOpenChange}
        options={options}
        productId={productFilter !== "all" ? productFilter : undefined}
        onCreated={refresh}
      />
    </>
  );
}
