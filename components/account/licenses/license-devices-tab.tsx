"use client";

import * as React from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { DataTable, DataTableEmptyState } from "@/components/data-table";
import { DeactivateButton, DeviceNameCell, DeviceStatusBadge, LastSeenCell } from "@/components/account/devices/device-cells";
import { DeactivateDevicesDialog, RenameDeviceDialog, type DeactivateRequest } from "@/components/account/devices/device-dialogs";
import { LocationSelect } from "@/components/account/devices/location-select";
import { resetsLeftText, slotsInUse } from "@/components/account/devices/model";
import { formatDateIST } from "@/lib/dates";
import type { AccountDevice, AccountLicenseDetail } from "@/lib/licensing/account";
import { LICENSE_STATUS_META } from "@/lib/licensing/status";
import { cn } from "@/lib/utils";
import { deviceUsage } from "./model";

const col = createColumnHelper<AccountDevice>();

const DEVICES_TITLE_ID = "license-devices-title";

type Options = {
  now: Date;
  locations: readonly { id: string; name: string }[];
  canManage: boolean;
  usable: boolean;
  onRename: (device: AccountDevice) => void;
  onDeactivate: (device: AccountDevice) => void;
};

/**
 * What the cells need, read through context so the columns stay one module constant: TanStack renders each cell
 * function as a component, so columns rebuilt after router.refresh() (a new `now`, new locations) remounted every
 * cell and dropped keyboard focus from the control just used (a location select, Rename).
 */
const OptionsContext = React.createContext<Options | null>(null);

function useOptions(): Options {
  const options = React.useContext(OptionsContext);
  if (!options) throw new Error("License device columns need their OptionsContext provider.");
  return options;
}

function NameCell({ device }: { device: AccountDevice }) {
  const { canManage, onRename } = useOptions();
  return <DeviceNameCell device={device} withIcon={false} onRename={() => onRename(device)} renameDisabled={!canManage} />;
}

function LocationCell({ device }: { device: AccountDevice }) {
  const { locations, canManage } = useOptions();
  return device.active ? (
    <LocationSelect device={device} locations={locations} disabledPerm={canManage ? undefined : "devices.manage"} />
  ) : (
    <span className="font-semibold">{device.locationName}</span>
  );
}

function LastSeen({ device }: { device: AccountDevice }) {
  const { now } = useOptions();
  return <LastSeenCell device={device} now={now} />;
}

function Actions({ device }: { device: AccountDevice }) {
  const { usable, canManage, onDeactivate } = useOptions();
  return usable && device.active ? <DeactivateButton canManage={canManage} label={device.name} onClick={() => onDeactivate(device)} /> : null;
}

const COLUMNS = [
  col.accessor("name", {
    header: "Device",
    enableSorting: false,
    meta: { rowHeader: true },
    cell: ({ row }) => <NameCell device={row.original} />,
  }),
  col.accessor("locationName", {
    header: "Location",
    enableSorting: false,
    cell: ({ row }) => <LocationCell device={row.original} />,
  }),
  col.accessor("activatedAt", {
    header: "Activated",
    enableSorting: false,
    meta: { className: "whitespace-nowrap font-semibold" },
    cell: ({ row }) => <time dateTime={row.original.activatedAt}>{formatDateIST(new Date(row.original.activatedAt))}</time>,
  }),
  col.accessor("lastSeenAt", {
    header: "Last seen",
    enableSorting: false,
    cell: ({ row }) => <LastSeen device={row.original} />,
  }),
  col.accessor((d) => (d.active ? (d.stale ? "stale" : "active") : "deactivated"), {
    id: "status",
    header: "Status",
    enableSorting: false,
    cell: ({ row }) => <DeviceStatusBadge device={row.original} />,
  }),
  col.display({
    id: "actions",
    meta: { srLabel: "Actions", align: "right" },
    cell: ({ row }) => <Actions device={row.original} />,
  }),
];

type License = AccountLicenseDetail["license"];

/**
 * Devices tab (prototype): slots in use with a progress bar, the self-service deactivations left this year, the
 * at-limit warning, and the license's devices (active first) with location, rename and Deactivate.
 */
export function LicenseDevicesTab({
  license,
  devices,
  locations,
  now,
  canManage,
}: {
  license: License;
  devices: readonly AccountDevice[];
  locations: readonly { id: string; name: string }[];
  now: Date;
  /** The member's role holds devices.manage (Owner, Technical contact). */
  canManage: boolean;
}) {
  const usable = LICENSE_STATUS_META[license.status].usable;
  const usage = deviceUsage(license.devicesUsed, license.deviceLimit);
  const [renaming, setRenaming] = React.useState<AccountDevice | null>(null);
  const [deactivating, setDeactivating] = React.useState<DeactivateRequest | null>(null);
  const left = license.selfServiceResetsLeft;
  const perYear = license.selfServiceResetsPerYear;
  const onDeactivate = React.useCallback(
    (device: AccountDevice) =>
      setDeactivating({ devices: [{ id: device.id, licenseId: device.licenseId, name: device.name }], skipped: 0, mode: "single", left, perYear }),
    [left, perYear],
  );
  const options = React.useMemo<Options>(
    () => ({ now, locations, canManage, usable, onRename: setRenaming, onDeactivate }),
    [now, locations, canManage, usable, onDeactivate],
  );

  return (
    <section aria-labelledby={DEVICES_TITLE_ID} className="rounded-16 border border-line-alt bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line-subtle px-[18px] py-3.5">
        <div className="min-w-0 flex-[1_1_240px]">
          {/* Focus target after a deactivation (the row's Deactivate button goes away). */}
          <h2 id={DEVICES_TITLE_ID} tabIndex={-1} className="m-0 text-[15px] font-extrabold leading-[normal] outline-none">
            {slotsInUse(license.devicesUsed, license.deviceLimit)}
          </h2>
          <div
            role="progressbar"
            aria-label="Device slots used"
            aria-valuemin={0}
            aria-valuemax={license.deviceLimit}
            aria-valuenow={Math.min(license.devicesUsed, license.deviceLimit)}
            aria-valuetext={`${license.devicesUsed} of ${license.deviceLimit}`}
            className="mt-2 h-1.5 max-w-[360px] overflow-hidden rounded-pill bg-line-subtle forced-color-adjust-none"
          >
            <div className={cn("h-full", usage.full ? "bg-warn-bar" : "bg-primary")} style={{ width: `${usage.pct}%` }} />
          </div>
        </div>
        {usable ? <span className="text-[12.5px] font-semibold text-ink-2">{resetsLeftText(left, perYear)}</span> : null}
      </div>
      {usable && usage.full ? (
        <div role="status" className="mx-[18px] mt-3.5 rounded-10 bg-peach-bg px-3 py-2.5 text-[13.5px] font-bold text-peach-fg">
          Activation limit reached. Deactivate a computer below, or add a computer to this license.
        </div>
      ) : null}
      <OptionsContext.Provider value={options}>
        <DataTable
          caption={`Devices on ${license.id}`}
          columns={COLUMNS}
          data={devices}
          getRowId={(d) => d.id}
          getRowLabel={(d) => d.name}
          minWidth={640}
          className="rounded-none border-0 bg-transparent"
          tableClassName="[&_thead_tr]:bg-transparent"
          emptyState={<DataTableEmptyState className="px-[18px] py-6 text-[14px]">No computers have used this license.</DataTableEmptyState>}
        />
      </OptionsContext.Provider>
      <RenameDeviceDialog device={renaming} onOpenChange={(open) => (open ? undefined : setRenaming(null))} />
      <DeactivateDevicesDialog
        request={deactivating}
        onOpenChange={(open) => (open ? undefined : setDeactivating(null))}
        focusAfterDone={() => document.getElementById(DEVICES_TITLE_ID)}
      />
    </section>
  );
}
