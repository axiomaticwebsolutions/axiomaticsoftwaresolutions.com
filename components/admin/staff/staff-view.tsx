"use client";

import type { ColumnDef } from "@tanstack/react-table";
import * as React from "react";
import { AdminTable } from "@/components/admin/admin-table";
import { adminToast } from "@/components/admin/admin-toaster";
import { downloadAdminCsv } from "@/components/admin/audit/download";
import { StatusBadge } from "@/components/admin/status-badge";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { useListState } from "@/components/data-table/use-list-state";
import { formatAdminDateTimeLong, relativeAgo } from "@/lib/admin/audit/format";
import type { ListPage } from "@/lib/admin/list-query";
import {
  roleLabel,
  STAFF_COPY,
  STAFF_LIST_STATE,
  staffDisplayName,
  staffStatusLabel,
  twoStepOn,
  type StaffRow,
} from "@/lib/admin/staff/model";
import { listStateToParams } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { StaffDrawer } from "./staff-drawer";

export type StaffViewProps = {
  /** The page the server rendered for the URL's q, filters, sort and page. */
  data: ListPage<StaffRow>;
  /** The ?id= staff member when they are not on this page (deep link), else null. */
  selected: StaffRow | null;
  /** Server render time (ISO) for relative dates. */
  now: string;
};

function NameCell({ row }: { row: StaffRow }) {
  return (
    <span className="grid min-w-0">
      <span className="truncate font-extrabold">{row.name.trim() || STAFF_COPY.invitationPending}</span>
      <span className="truncate text-[11.5px] font-semibold text-ink-2">{row.email}</span>
    </span>
  );
}

function TwoStep({ row }: { row: StaffRow }) {
  const on = twoStepOn(row);
  return <span className={cn("font-semibold", on ? "text-sage-fg" : "text-danger")}>{on ? "On" : "Off"}</span>;
}

function staffColumns(now: string): ColumnDef<StaffRow>[] {
  return [
    {
      id: "name",
      header: STAFF_COPY.columns.name,
      enableSorting: true,
      cell: ({ row }) => <NameCell row={row.original} />,
      meta: { rowHeader: true, label: STAFF_COPY.columns.name, className: "max-w-[320px]" },
    },
    {
      id: "role",
      header: STAFF_COPY.columns.role,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge kind="role" status={row.original.role} />,
    },
    {
      id: "status",
      header: STAFF_COPY.columns.status,
      enableSorting: false,
      cell: ({ row }) => <StatusBadge kind="staff" status={row.original.status} label={staffStatusLabel(row.original)} />,
    },
    {
      id: "twoStep",
      header: STAFF_COPY.columns.twoStep,
      enableSorting: false,
      cell: ({ row }) => <TwoStep row={row.original} />,
    },
    {
      id: "lastActive",
      header: STAFF_COPY.columns.lastActive,
      enableSorting: true,
      cell: ({ row }) => {
        const at = row.original.lastActiveAt;
        return at ? (
          <time dateTime={at} title={formatAdminDateTimeLong(at)} className="whitespace-nowrap font-semibold">
            {relativeAgo(at, now)}
          </time>
        ) : (
          <span className="font-semibold text-ink-2">{"\u2014"}</span>
        );
      },
      meta: { sortLabels: { asc: "least recent first", desc: "most recent first" } },
    },
  ];
}

/** Card below 760px (prototype mobile: name or email, role, status badge). */
function staffCard(row: StaffRow): React.ReactNode {
  return (
    <span className="flex items-start justify-between gap-2.5">
      <span className="grid min-w-0">
        <span className="break-words text-[14px] font-extrabold">{staffDisplayName(row)}</span>
        <span className="text-[12.5px] font-semibold text-ink-2">{roleLabel(row.role)}</span>
      </span>
      <StatusBadge kind="staff" status={row.status} label={staffStatusLabel(row)} />
    </span>
  );
}

/**
 * Staff table (prototype mods.staff): search, "{n} results", CSV (reports.export), NAME / ROLE / STATUS / 2-STEP /
 * LAST ACTIVE, rows open the staff drawer (?id=). Search, sort and page live in the URL; the server renders rows.
 */
export function StaffView({ data, selected, now }: StaffViewProps) {
  const list = useListState(STAFF_LIST_STATE);
  const drawer = useDrawerParam();
  const columns = React.useMemo(() => staffColumns(now), [now]);
  const openRow = drawer.id ? (data.items.find((r) => r.id === drawer.id) ?? (selected?.id === drawer.id ? selected : null)) : null;

  async function exportCsv() {
    const params = listStateToParams(list.applied, STAFF_LIST_STATE);
    params.delete("page");
    params.delete("pageSize");
    const query = params.toString();
    try {
      const file = await downloadAdminCsv(`/api/admin/staff/export.csv${query ? `?${query}` : ""}`, "staff.csv");
      adminToast.success(file.rows === null ? `Exported ${file.fileName}` : STAFF_COPY.exported(file.rows, file.fileName));
    } catch (error) {
      adminToast.error(error);
    }
  }

  return (
    <>
      <AdminTable
        columns={columns}
        data={data.items}
        getRowId={(row) => row.id}
        getRowLabel={staffDisplayName}
        caption={STAFF_COPY.caption}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: STAFF_COPY.searchPlaceholder, label: STAFF_COPY.searchLabel },
          onClear: list.clear,
          canClear: list.isFiltered,
          csv: { fileName: "staff.csv", onExport: exportCsv },
        }}
        exportPerm="staff.manage"
        resultCount={data.total}
        pagination={{
          page: list.applied.page,
          pageSize: data.pageSize,
          total: data.total,
          onPageChange: list.setPage,
          pageHref: list.pageHref,
        }}
        mobileCard={staffCard}
        loading={list.isPending}
        onRowClick={(row) => drawer.open(row.id)}
        rowClassName={(row) => (row.id === drawer.id ? "bg-lavender-soft" : undefined)}
        minWidth={820}
      />
      <StaffDrawer row={openRow} open={drawer.isOpen} onOpenChange={drawer.onOpenChange} close={drawer.close} now={now} />
    </>
  );
}
