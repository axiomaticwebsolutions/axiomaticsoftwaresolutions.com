"use client";

import * as React from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { formatDateIST } from "@/lib/dates";
import { DeactivateButton, DeviceNameCell, DeviceStatusBadge, LastSeenCell, LicenseLinkCell } from "./device-cells";
import { LocationSelect } from "./location-select";
import { isDeactivatable, type DeviceRow } from "./model";

const col = createColumnHelper<DeviceRow>();

export type DeviceColumnOptions = {
  now: Date;
  locations: readonly { id: string; name: string }[];
  canManage: boolean;
  onDeactivate: (device: DeviceRow) => void;
};

/**
 * What the cells need from the page, read through context rather than captured by the columns: TanStack renders each
 * cell function as a component, so columns rebuilt after router.refresh() (a new `now`, new locations) remounted every
 * cell and dropped keyboard focus from the control just used (a location select, a Deactivate button).
 */
export const DeviceColumnsContext = React.createContext<DeviceColumnOptions | null>(null);

function useColumnOptions(): DeviceColumnOptions {
  const options = React.useContext(DeviceColumnsContext);
  if (!options) throw new Error("Device columns need a DeviceColumnsContext provider.");
  return options;
}

function LocationCell({ device }: { device: DeviceRow }) {
  const { locations, canManage } = useColumnOptions();
  return device.active ? (
    <LocationSelect device={device} locations={locations} disabledPerm={canManage ? undefined : "devices.manage"} />
  ) : (
    <span className="font-semibold">{device.locationName}</span>
  );
}

function LastSeen({ device }: { device: DeviceRow }) {
  const { now } = useColumnOptions();
  return <LastSeenCell device={device} now={now} />;
}

function Actions({ device }: { device: DeviceRow }) {
  const { canManage, onDeactivate } = useColumnOptions();
  return isDeactivatable(device) ? <DeactivateButton canManage={canManage} label={device.name} onClick={() => onDeactivate(device)} /> : null;
}

/**
 * Fleet columns (prototype order): device, license, location, activated, last seen, status, Deactivate. A module
 * constant (stable across refreshes); render the table inside <DeviceColumnsContext.Provider>.
 */
export const DEVICE_COLUMNS = [
  col.accessor("name", {
    header: "Device",
    enableSorting: false,
    meta: { rowHeader: true },
    cell: ({ row }) => <DeviceNameCell device={row.original} />,
  }),
  col.accessor("licenseId", {
    header: "License",
    enableSorting: false,
    cell: ({ row }) => <LicenseLinkCell device={row.original} />,
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
