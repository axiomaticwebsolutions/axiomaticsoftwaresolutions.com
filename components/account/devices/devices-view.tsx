"use client";

import * as React from "react";
import { toast } from "@/components/ui/sonner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { usePortal } from "@/components/account/portal-context";
import { teamRequiresLabel } from "@/components/account/portal-nav";
import {
  BulkAction,
  DataTable,
  DataTableEmptyState,
  DataTableStats,
  EmptyStateAction,
  StatTile,
  pruneSelection,
  useListState,
} from "@/components/data-table";
import { csvFileName, downloadCsv, toCsv } from "@/lib/csv";
import type { DeviceFleetData } from "./data";
import { DEVICE_COLUMNS, DeviceColumnsContext, type DeviceColumnOptions } from "./devices-columns";
import { DeactivateDevicesDialog, type DeactivateRequest } from "./device-dialogs";
import { ManageLocationsDialog } from "./manage-locations-dialog";
import {
  DEVICE_CSV_COLUMNS,
  DEVICE_STATUS_OPTIONS,
  DEVICES_CSV_FILE,
  DEVICES_LIST,
  DEVICES_PAGE_SIZE,
  devicesFooter,
  filterDevices,
  isDeactivatable,
  locationFilterOptions,
  parseDeviceStatus,
  planDeactivation,
  skippedDevicesNote,
  type DeviceRow,
} from "./model";

function exportDevices(rows: readonly DeviceRow[]) {
  downloadCsv(DEVICES_CSV_FILE, toCsv(rows, DEVICE_CSV_COLUMNS));
  const n = rows.length;
  toast.success(`Exported ${n.toLocaleString("en-IN")} ${n === 1 ? "row" : "rows"} to ${csvFileName(DEVICES_CSV_FILE)}`);
}

const toTarget = (d: DeviceRow) => ({ id: d.id, licenseId: d.licenseId, name: d.name });

const DEVICES_TABLE_ID = "devices-table";

/**
 * Focus target after a deactivation: the table frame (focusable, tabIndex -1), as DataTable does when its bulk bar
 * closes. "Deactivate selected" and the row's Deactivate button are gone by then.
 */
function tableFrame(): HTMLElement | null {
  const root = document.getElementById(DEVICES_TABLE_ID);
  if (!root) return null;
  return root.matches('[data-slot="data-table"]') ? root : root.querySelector<HTMLElement>('[data-slot="data-table"]');
}

/** /account/devices: the fleet across every license and location (Customer Portal prototype "Devices"). */
export function DevicesView({ data }: { data: DeviceFleetData }) {
  const { can } = usePortal();
  const canManage = can("devices.manage");
  const list = useListState(DEVICES_LIST, { mode: "client" });
  const { q, filters, page } = list.state;
  const now = React.useMemo(() => new Date(data.now), [data.now]);
  const rows = React.useMemo(
    () => filterDevices(data.rows, { q, status: filters.status, location: filters.location }),
    [data.rows, q, filters.status, filters.location],
  );
  const [selected, setSelected] = React.useState<readonly string[]>([]);
  const selectable = React.useMemo(() => rows.filter(isDeactivatable).map((d) => d.id), [rows]);
  const visibleSelected = React.useMemo(() => pruneSelection(selected, selectable), [selected, selectable]);
  const [deactivating, setDeactivating] = React.useState<DeactivateRequest | null>(null);
  const [locationsOpen, setLocationsOpen] = React.useState(false);

  const { resetsLeft, perYear } = data;
  const openDeactivate = React.useCallback(
    (devices: readonly DeviceRow[]) => {
      const plan = planDeactivation(devices, resetsLeft);
      if (plan.run.length === 0) {
        toast.error(skippedDevicesNote(plan.skipped.length));
        return;
      }
      setDeactivating({ devices: plan.run.map(toTarget), skipped: plan.skipped.length, mode: "bulk", left: 0, perYear });
    },
    [resetsLeft, perYear],
  );
  const onDeactivateRow = React.useCallback((device: DeviceRow) => openDeactivate([device]), [openDeactivate]);
  const columnOptions = React.useMemo<DeviceColumnOptions>(
    () => ({ now, locations: data.locations, canManage, onDeactivate: onDeactivateRow }),
    [now, data.locations, canManage, onDeactivateRow],
  );

  const selectedRows = () => {
    const ids = new Set(visibleSelected);
    return data.rows.filter((d) => ids.has(d.id));
  };
  const status = parseDeviceStatus(filters.status);
  const { stats } = data;
  const footer = `${devicesFooter(rows.length)}${data.truncated ? " · only the 500 most recent devices are listed" : ""}`;

  return (
    <>
      <PageHeader
        title="Devices"
        description="Every computer and terminal using your licenses, across all locations. Free up slots when replacing hardware."
        actions={
          <>
            <PageAction icon="storefront" perm="devices.manage" onClick={() => setLocationsOpen(true)}>
              Manage locations
            </PageAction>
            <PageAction icon="download" onClick={() => exportDevices(rows)}>
              Export CSV
            </PageAction>
          </>
        }
      />
      <DeviceColumnsContext.Provider value={columnOptions}>
        <DataTable
          id={DEVICES_TABLE_ID}
          className="animate-enter-up motion-reduce:animate-none"
          caption="Devices"
          columns={DEVICE_COLUMNS}
          data={rows}
          getRowId={(d) => d.id}
          getRowLabel={(d) => d.name}
          minWidth={860}
          stats={
            <DataTableStats aria-label="Device summary" className="max-cards:grid-cols-2">
              <StatTile label="Active devices" value={stats.activeDevices.toLocaleString("en-IN")} />
              <StatTile label="Free slots" value={stats.freeSlots.toLocaleString("en-IN")} tone="sage" />
              <StatTile
                label="Not seen recently"
                value={stats.staleDevices.toLocaleString("en-IN")}
                tone={stats.staleDevices > 0 ? "peach" : "default"}
              />
              <StatTile label="Locations" value={stats.locations.toLocaleString("en-IN")} />
            </DataTableStats>
          }
          toolbar={{
            search: { value: q, onChange: list.setQuery, placeholder: "Device name, OS or license", label: "Search devices" },
            controls: (
              <SegmentedControl
                variant="chip"
                aria-label="Status"
                // Phones: a tidy 2 x 2 track across the toolbar instead of "All" wrapping onto a line of its own.
                className="max-[30rem]:grid max-[30rem]:w-full max-[30rem]:grid-cols-2 max-[30rem]:[&>button]:justify-center"
                options={DEVICE_STATUS_OPTIONS}
                value={status}
                onValueChange={(value) => list.setFilter("status", value)}
              />
            ),
            filters: [
              {
                id: "location",
                label: "Location",
                options: locationFilterOptions(data.locations),
                value: filters.location,
                onChange: (value) => list.setFilter("location", value),
              },
            ],
          }}
          selection={{
            selected: visibleSelected,
            onChange: setSelected,
            isRowSelectable: isDeactivatable,
            selectAllLabel: "Select all active devices",
            bulkActions: (
              <>
                <BulkAction
                  tone="danger"
                  disabledReason={canManage ? undefined : teamRequiresLabel("devices.manage")}
                  onClick={() => openDeactivate(selectedRows())}
                >
                  Deactivate selected
                </BulkAction>
                <BulkAction onClick={() => exportDevices(selectedRows())}>Export selected</BulkAction>
              </>
            ),
          }}
          pagination={
            rows.length > DEVICES_PAGE_SIZE
              ? {
                  page,
                  pageSize: DEVICES_PAGE_SIZE,
                  onPageChange: list.setPage,
                  pageHref: list.pageHref,
                  label: "Device pages",
                  rangeLabel: ({ from, to, total }) => `Showing ${from}–${to} of ${total.toLocaleString("en-IN")} devices`,
                }
              : undefined
          }
          footer={rows.length > DEVICES_PAGE_SIZE ? undefined : footer}
          emptyState={
            data.rows.length === 0 ? (
              <DataTableEmptyState title="No devices yet">
                Computers appear here once the software is activated with one of your license keys.
              </DataTableEmptyState>
            ) : (
              <DataTableEmptyState action={list.isFiltered ? <EmptyStateAction clearsFilters onClick={list.clear}>Clear filters</EmptyStateAction> : undefined}>
                No devices match these filters.
              </DataTableEmptyState>
            )
          }
        />
      </DeviceColumnsContext.Provider>
      <DeactivateDevicesDialog
        request={deactivating}
        onOpenChange={(open) => (open ? undefined : setDeactivating(null))}
        onDone={(ids) => setSelected((current) => current.filter((id) => !ids.includes(id)))}
        focusAfterDone={tableFrame}
      />
      <ManageLocationsDialog open={locationsOpen} onOpenChange={setLocationsOpen} />
    </>
  );
}
