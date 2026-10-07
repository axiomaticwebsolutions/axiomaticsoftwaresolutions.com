"use client";

import type { ColumnDef } from "@tanstack/react-table";
import * as React from "react";
import { AdminTable } from "@/components/admin/admin-table";
import { adminToast } from "@/components/admin/admin-toaster";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { FilterSelect } from "@/components/data-table/filter-select";
import { VARIANT_STYLES } from "@/components/data-table/styles";
import { useListState } from "@/components/data-table/use-list-state";
import { formatAdminDateTime, formatAdminDateTimeLong, relativeAgo } from "@/lib/admin/audit/format";
import {
  AUDIT_COPY,
  AUDIT_LIST_STATE,
  AUDIT_ROLE_LABELS,
  AUDIT_ROLES,
  auditDetailText,
  auditRoleLabel,
  maskIp,
  type AuditFacets,
  type AuditFilterKey,
  type AuditOption,
  type AuditRow,
} from "@/lib/admin/audit/model";
import type { ListPage } from "@/lib/admin/list-query";
import { ALL, listStateToParams } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { auditCard } from "./audit-card";
import { AuditDrawer } from "./audit-drawer";
import { downloadAdminCsv } from "./download";

export type AuditViewProps = {
  data: ListPage<AuditRow>;
  facets: AuditFacets;
  /** The ?id= event when it is not on this page (deep link), else null. */
  selected: AuditRow | null;
  now: string;
};

const ROLE_OPTIONS: AuditOption[] = AUDIT_ROLES.map((role) => ({ value: role, label: AUDIT_ROLE_LABELS[role] }));

function withAll(options: readonly AuditOption[]): AuditOption[] {
  return [{ value: ALL, label: AUDIT_COPY.all }, ...options];
}

function auditColumns(now: string): ColumnDef<AuditRow>[] {
  return [
    {
      id: "createdAt",
      header: AUDIT_COPY.columns.when,
      enableSorting: true,
      cell: ({ row }) => (
        <time dateTime={row.original.at} title={formatAdminDateTimeLong(row.original.at)} className="grid whitespace-nowrap">
          <span className="font-semibold">{formatAdminDateTime(row.original.at)}</span>
          <span className="text-[11.5px] font-semibold text-ink-2">{relativeAgo(row.original.at, now)}</span>
        </time>
      ),
      meta: { sortLabels: { asc: "oldest first", desc: "newest first" } },
    },
    {
      id: "actor",
      header: AUDIT_COPY.columns.actor,
      enableSorting: true,
      cell: ({ row }) => (
        <span className="grid">
          <span className="font-extrabold">{row.original.actorName}</span>
          <span className="text-[11.5px] font-semibold text-ink-2">{auditRoleLabel(row.original.actorRole)}</span>
        </span>
      ),
    },
    {
      id: "action",
      header: AUDIT_COPY.columns.action,
      enableSorting: true,
      cell: ({ row }) => <span className="font-semibold">{row.original.action}</span>,
      meta: { rowHeader: true, label: AUDIT_COPY.columns.action },
    },
    {
      id: "target",
      header: AUDIT_COPY.columns.target,
      enableSorting: false,
      cell: ({ row }) => <span className="break-words font-mono text-[12px] font-bold">{row.original.target}</span>,
      meta: { className: "max-w-[260px]" },
    },
    {
      id: "detail",
      header: AUDIT_COPY.columns.detail,
      enableSorting: false,
      cell: ({ row }) => <span className="break-words font-semibold text-ink-2">{auditDetailText(row.original)}</span>,
      meta: { className: "max-w-[260px]" },
    },
    {
      id: "ip",
      header: AUDIT_COPY.columns.ip,
      enableSorting: false,
      cell: ({ row }) => <span className="whitespace-nowrap font-mono text-[12px] font-bold text-ink-2">{maskIp(row.original.ipPrefix)}</span>,
    },
  ];
}

function DateFilter(props: { label: string; value: string; min?: string; max?: string; onChange: (value: string) => void }) {
  const styles = VARIANT_STYLES.admin;
  return (
    <label className={cn("flex min-w-0 items-center gap-1.5 font-bold text-ink-2", styles.filterLabel)}>
      <span className="whitespace-nowrap">{props.label}</span>
      <input
        type="date"
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(event) => props.onChange(event.target.value)}
        className={cn(
          "min-w-0 cursor-pointer border border-line-strong bg-surface px-2 font-bold text-ink",
          "transition-[border-color,box-shadow] duration-150 hover:border-line-input field-focus",
          styles.control,
        )}
      />
    </label>
  );
}

const dateValue = (value: string | undefined) => (value && value !== ALL ? value : "");

/**
 * Audit log table (prototype mods.audit): search, Actor (role), Person, Action and Target selects, an IST date range,
 * "{n} results" and CSV (audit.view; the export is itself audited). WHEN / ACTOR / ACTION sort on the server; rows
 * open the read-only event drawer (?id=). Newest first, 25 per page.
 */
export function AuditView({ data, facets, selected, now }: AuditViewProps) {
  const list = useListState(AUDIT_LIST_STATE);
  const drawer = useDrawerParam();
  const columns = React.useMemo(() => auditColumns(now), [now]);
  const card = React.useMemo(() => auditCard(now), [now]);
  const openRow = drawer.id ? (data.items.find((r) => r.id === drawer.id) ?? (selected?.id === drawer.id ? selected : null)) : null;
  const filters = list.state.filters;

  const select = (id: AuditFilterKey, label: string, options: readonly AuditOption[]) => (
    <FilterSelect
      key={id}
      label={label}
      options={withAll(options)}
      value={filters[id]}
      onValueChange={(value) => list.setFilter(id, value)}
      variant="admin"
      className="max-w-[220px]"
    />
  );

  async function exportCsv() {
    const params = listStateToParams(list.applied, AUDIT_LIST_STATE);
    params.delete("page");
    params.delete("pageSize");
    const query = params.toString();
    try {
      const file = await downloadAdminCsv(`/api/admin/audit/export.csv${query ? `?${query}` : ""}`, "audit-log.csv");
      adminToast.success(file.rows === null ? `Exported ${file.fileName}` : AUDIT_COPY.exported(file.rows, file.fileName, file.truncated));
    } catch (error) {
      adminToast.error(error);
    }
  }

  const from = dateValue(filters.from);
  const to = dateValue(filters.to);

  return (
    <>
      <AdminTable
        columns={columns}
        data={data.items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => `${row.action} ${row.target}`}
        caption={AUDIT_COPY.caption}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: AUDIT_COPY.searchPlaceholder, label: AUDIT_COPY.searchLabel },
          controls: (
            <>
              {select("role", AUDIT_COPY.filters.role, ROLE_OPTIONS)}
              {select("actor", AUDIT_COPY.filters.actor, facets.actors)}
              {select("action", AUDIT_COPY.filters.action, facets.actions)}
              {select("targetType", AUDIT_COPY.filters.targetType, facets.targetTypes)}
              <DateFilter label={AUDIT_COPY.filters.from} value={from} max={to || undefined} onChange={(v) => list.setFilter("from", v || ALL)} />
              <DateFilter label={AUDIT_COPY.filters.to} value={to} min={from || undefined} onChange={(v) => list.setFilter("to", v || ALL)} />
            </>
          ),
          onClear: list.clear,
          canClear: list.isFiltered,
          csv: { fileName: "audit-log.csv", onExport: exportCsv },
        }}
        exportPerm="audit.view"
        resultCount={data.total}
        pagination={{
          page: list.applied.page,
          pageSize: data.pageSize,
          total: data.total,
          onPageChange: list.setPage,
          pageHref: list.pageHref,
        }}
        mobileCard={card}
        loading={list.isPending}
        onRowClick={(row) => drawer.open(row.id)}
        rowClassName={(row) => (row.id === drawer.id ? "bg-lavender-soft" : undefined)}
        minWidth={980}
      />
      <AuditDrawer row={openRow} open={drawer.isOpen} onOpenChange={drawer.onOpenChange} />
    </>
  );
}
