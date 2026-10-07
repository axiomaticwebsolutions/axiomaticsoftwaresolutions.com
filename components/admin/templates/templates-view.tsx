"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminTable } from "@/components/admin/admin-table";
import { exportCsv, exportHref } from "@/components/admin/coupons/export";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { useListState } from "@/components/data-table/use-list-state";
import {
  filterAndSortTemplates,
  TEMPLATE_COPY,
  TEMPLATE_STATUS_LABELS,
  TEMPLATE_STATUSES,
  TEMPLATES_LIST,
  type TemplateDto,
  type TemplatePreviewContext,
  type TemplateSort,
  type TemplateStatus,
} from "@/lib/admin/templates/model";
import { templateCard, templateColumns } from "./template-columns";
import { TemplateDrawer } from "./template-drawer";

type Props = {
  templates: TemplateDto[];
  preview: TemplatePreviewContext;
  /** Server time (ISO) for "3d ago", so server and client render the same text. */
  now: string;
};

const STATUS_OPTIONS = [{ value: "all", label: "All" }, ...TEMPLATE_STATUSES.map((s) => ({ value: s, label: TEMPLATE_STATUS_LABELS[s] }))];

/** Templates table (Admin Console.dc.html #templates): search, Status filter, sortable Template / Updated, CSV, drawer. */
export function TemplatesView({ templates, preview, now }: Props) {
  const router = useRouter();
  const list = useListState(TEMPLATES_LIST, { mode: "client" });
  const drawer = useDrawerParam();
  const [refreshing, startRefresh] = React.useTransition();
  const refresh = React.useCallback(() => startRefresh(() => router.refresh()), [router]);
  const columns = React.useMemo(() => templateColumns(now), [now]);

  const status = list.state.filters.status;
  const rows = React.useMemo(
    () =>
      filterAndSortTemplates(templates, {
        q: list.state.q,
        filters: { status: status === "all" ? undefined : (status as TemplateStatus) },
        sort: (list.state.sort ?? { id: "order", desc: false }) as { id: TemplateSort; desc: boolean },
      }),
    [templates, list.state.q, list.state.sort, status],
  );
  const pageSize = list.state.pageSize;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(list.state.page, pageCount);
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  const current = drawer.id ? (templates.find((t) => t.id === drawer.id) ?? null) : null;

  return (
    <>
      <AdminTable
        caption={TEMPLATE_COPY.caption}
        columns={columns}
        data={pageRows}
        getRowId={(t) => t.id}
        getRowLabel={(t) => t.name}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        manual
        loading={refreshing}
        minWidth={760}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: TEMPLATE_COPY.searchPlaceholder, label: TEMPLATE_COPY.searchLabel },
          filters: [{ id: "status", label: "Status", options: STATUS_OPTIONS, value: status, onChange: (v) => list.setFilter("status", v) }],
          onClear: list.clear,
          csv: { fileName: "templates.csv", onExport: () => exportCsv(exportHref("/api/admin/templates/export.csv", list.state, TEMPLATES_LIST), "templates.csv") },
        }}
        exportPerm={["reports.export", "templates.manage"]}
        resultCount={rows.length}
        pagination={{ page, pageSize, total: rows.length, onPageChange: list.setPage, pageHref: list.pageHref }}
        onRowClick={(t) => drawer.open(t.id)}
        mobileCard={templateCard}
      />
      <TemplateDrawer open={drawer.isOpen} onOpenChange={drawer.onOpenChange} template={current} preview={preview} onChanged={refresh} />
    </>
  );
}
