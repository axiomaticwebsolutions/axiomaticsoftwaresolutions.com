"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminTable } from "@/components/admin/admin-table";
import { exportCsv, exportHref } from "@/components/admin/coupons/export";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { useListState } from "@/components/data-table/use-list-state";
import {
  LEAD_COPY,
  LEAD_KIND_ENUM,
  LEAD_KIND_LABELS,
  LEAD_KIND_VALUES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_VALUES,
  LEADS_LIST,
  type LeadDto,
} from "@/lib/admin/leads/model";
import { leadCard, leadColumns } from "./lead-columns";
import { LeadDrawer } from "./lead-drawer";

type Props = {
  /** The page of leads the server rendered for the URL's list state. */
  items: LeadDto[];
  total: number;
  /** Server time (ISO) for relative times. */
  now: string;
};

const KIND_OPTIONS = [
  { value: "all", label: "All" },
  ...LEAD_KIND_VALUES.map((k) => ({ value: k, label: LEAD_KIND_LABELS[LEAD_KIND_ENUM[k]] })),
];
const STATUS_OPTIONS = [{ value: "all", label: "All" }, ...LEAD_STATUS_VALUES.map((s) => ({ value: s, label: LEAD_STATUS_LABELS[s] }))];

/**
 * Leads inbox table: search, Type and Status filters, sortable Request / Status / Received, server paging (URL list
 * state, server mode), CSV (reports.export) and the request drawer (?id=DEMO-1001).
 */
export function LeadsView({ items, total, now }: Props) {
  const router = useRouter();
  const list = useListState(LEADS_LIST);
  const drawer = useDrawerParam();
  const [refreshing, startRefresh] = React.useTransition();
  const refresh = React.useCallback(() => startRefresh(() => router.refresh()), [router]);
  const columns = React.useMemo(() => leadColumns(now), [now]);
  const row = drawer.id ? (items.find((l) => l.id === drawer.id) ?? null) : null;

  return (
    <>
      <AdminTable
        caption={LEAD_COPY.caption}
        columns={columns}
        data={items}
        getRowId={(l) => l.id}
        getRowLabel={(l) => `${l.id} ${l.name}`}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        manual
        loading={list.isPending || refreshing}
        minWidth={900}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: LEAD_COPY.searchPlaceholder, label: LEAD_COPY.searchLabel },
          filters: [
            { id: "kind", label: "Type", options: KIND_OPTIONS, value: list.state.filters.kind, onChange: (v) => list.setFilter("kind", v) },
            { id: "status", label: "Status", options: STATUS_OPTIONS, value: list.state.filters.status, onChange: (v) => list.setFilter("status", v) },
          ],
          onClear: list.clear,
          csv: { fileName: "leads.csv", onExport: () => exportCsv(exportHref("/api/admin/leads/export.csv", list.applied, LEADS_LIST), "leads.csv") },
        }}
        exportPerm={["reports.export", "leads.view"]}
        resultCount={total}
        pagination={{ page: list.applied.page, pageSize: list.applied.pageSize, total, onPageChange: list.setPage, pageHref: list.pageHref }}
        onRowClick={(l) => drawer.open(l.id)}
        mobileCard={leadCard}
        emptyMessage={LEAD_COPY.empty}
      />
      <LeadDrawer open={drawer.isOpen} onOpenChange={drawer.onOpenChange} id={drawer.id} row={row} now={now} onChanged={refresh} />
    </>
  );
}
