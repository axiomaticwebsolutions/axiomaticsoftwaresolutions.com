/**
 * View model of the portal device pages (Customer Portal prototype "Devices" fleet and the license Devices tab):
 * device states and badges, icons, filters, the bulk-deactivation plan that respects each license's yearly
 * self-service limit, dialog and toast copy, and the CSV columns. Pure and client-safe (no React).
 */
import type { IconSourceName } from "@/components/icons/icon-names";
import type { BadgeTone } from "@/components/ui/badge";
import { relativeTime } from "@/components/account/portal-nav";
import { matchesQuery } from "@/components/data-table/model";
import type { DataTableOption } from "@/components/data-table/types";
import type { CsvColumn } from "@/lib/csv";
import type { AccountDevice } from "@/lib/licensing/account";
import { defineListState } from "@/lib/url-state";
import { istIsoDate } from "@/components/account/licenses/model";

/** A fleet row: the API device plus whether its license still allows device changes (active, expiring, trial). */
export type DeviceRow = AccountDevice & { licenseUsable: boolean };

export type DeviceState = "active" | "stale" | "deactivated";

/** Badges: Active (sage), Not seen recently (peach; active but unseen for 30 days), Deactivated (slate). */
export const DEVICE_STATE_META: Record<DeviceState, { label: string; tone: BadgeTone }> = {
  active: { label: "Active", tone: "sage" },
  stale: { label: "Not seen recently", tone: "peach" },
  deactivated: { label: "Deactivated", tone: "slate" },
};

export function deviceState(device: Pick<AccountDevice, "active" | "stale">): DeviceState {
  if (!device.active) return "deactivated";
  return device.stale ? "stale" : "active";
}

/** Phone for Android/iPhone, laptop when the name says so, else a desktop (prototype rule). */
export function deviceIcon(device: Pick<AccountDevice, "os" | "name">): IconSourceName {
  if (/android|iphone|ios/i.test(device.os)) return "smartphone";
  if (/lap/i.test(device.name)) return "laptop";
  return "desktop_windows";
}

/** Active device on a usable license: may be deactivated by a member with devices.manage. */
export function isDeactivatable(device: Pick<DeviceRow, "active" | "licenseUsable">): boolean {
  return device.active && device.licenseUsable;
}

export const DEVICE_STATUS_FILTERS = ["active", "stale", "inactive", "all"] as const;
export type DeviceStatusFilter = (typeof DEVICE_STATUS_FILTERS)[number];

export const DEVICE_STATUS_OPTIONS: readonly { value: DeviceStatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "stale", label: "Not seen recently" },
  { value: "inactive", label: "Deactivated" },
  { value: "all", label: "All" },
];

export const DEVICES_PAGE_SIZE = 50;
/** Location filter value for devices without a location. */
export const UNASSIGNED_FILTER = "none";

/** URL state of the fleet: ?q=&status=(active)&location=&page= (defaults left out). */
export const DEVICES_LIST = defineListState({
  filters: { status: { values: DEVICE_STATUS_FILTERS, default: "active" }, location: {} },
  pageSize: DEVICES_PAGE_SIZE,
});

export function locationFilterOptions(locations: readonly { id: string; name: string }[]): DataTableOption[] {
  return [
    { value: "all", label: "All locations" },
    ...locations.map((l) => ({ value: l.id, label: l.name })),
    { value: UNASSIGNED_FILTER, label: "Unassigned" },
  ];
}

export function parseDeviceStatus(value: string): DeviceStatusFilter {
  return (DEVICE_STATUS_FILTERS as readonly string[]).includes(value) ? (value as DeviceStatusFilter) : "active";
}

export type DeviceFilters = { q: string; status: string; location: string };

/** Status tab, location and search (device name, OS, license id or product), as the prototype. */
export function filterDevices<D extends AccountDevice>(rows: readonly D[], f: DeviceFilters): D[] {
  const status = parseDeviceStatus(f.status);
  return rows.filter(
    (d) =>
      (status === "all" || (status === "active" && d.active) || (status === "inactive" && !d.active) || (status === "stale" && d.stale)) &&
      (f.location === "all" || (f.location === UNASSIGNED_FILTER ? d.locationId === null : d.locationId === f.location)) &&
      matchesQuery(f.q, [d.name, d.os, d.licenseId, d.productShortName]),
  );
}

export function lastSeenText(device: Pick<AccountDevice, "lastSeenAt">, now: Date): string {
  return relativeTime(new Date(device.lastSeenAt), now);
}

/**
 * Which selected devices can be deactivated: active devices on usable licenses, at most the license's self-service
 * deactivations left this year (unknown licenses are left to the server). The rest are skipped up front.
 */
export function planDeactivation<D extends Pick<DeviceRow, "id" | "licenseId" | "active" | "licenseUsable">>(
  devices: readonly D[],
  resetsLeft: Readonly<Record<string, number>>,
): { run: D[]; skipped: D[] } {
  const used = new Map<string, number>();
  const run: D[] = [];
  const skipped: D[] = [];
  for (const device of devices) {
    if (!isDeactivatable(device)) {
      skipped.push(device);
      continue;
    }
    const left = resetsLeft[device.licenseId];
    const taken = used.get(device.licenseId) ?? 0;
    if (left !== undefined && taken >= left) {
      skipped.push(device);
      continue;
    }
    used.set(device.licenseId, taken + 1);
    run.push(device);
  }
  return { run, skipped };
}

function plural(n: number, one: string, other: string): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : other}`;
}

/** Names in a dialog sentence: all of them up to five, then "and N more". */
export function deviceNames(names: readonly string[], max = 5): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** Fleet dialog (one or many devices): "Deactivate 2 devices?" + the prototype's consequence sentence. */
export function bulkDeactivateCopy(names: readonly string[], perYear: number): { title: string; body: string } {
  const n = names.length;
  return {
    title: `Deactivate ${plural(n, "device", "devices")}?`,
    body: `Software on ${deviceNames(names)} will stop working until activated again. Each deactivation uses one of the license’s ${perYear} yearly self-service resets.`,
  };
}

/** New copy: selected devices that cannot be deactivated now (limit used up, already deactivated, license not active). */
export function skippedDevicesNote(skipped: number): string {
  return skipped === 1
    ? "1 selected device can’t be deactivated now: its license has no self-service deactivations left this year, or it isn’t active."
    : `${skipped} selected devices can’t be deactivated now: their license has no self-service deactivations left this year, or they aren’t active.`;
}

/** License Devices tab dialog: 'Deactivate “Billing counter PC”?' and the deactivations left this year. */
export function singleDeactivateCopy(name: string, left: number): { title: string; body: string } {
  return {
    title: `Deactivate “${name}”?`,
    body: `The software on this computer stops working until it’s activated again. You have ${left} self-service deactivation${left === 1 ? "" : "s"} left this year.`,
  };
}

/** "2 devices deactivated" (+ " · some were skipped"). */
export function deactivatedToast(ok: number, skipped: boolean): string {
  return `${plural(ok, "device", "devices")} deactivated${skipped ? " · some were skipped" : ""}`;
}

/** Name of the "no location" choice in the row location select. */
export const UNASSIGNED_LABEL = "Unassigned";
/** Listbox value of "Unassigned" in the row location select (a listbox option cannot use ""). */
export const UNASSIGNED_SELECT_VALUE = "__unassigned";

/** Row location select value for a device's location id (null = Unassigned). */
export function locationSelectValue(locationId: string | null): string {
  return locationId ?? UNASSIGNED_SELECT_VALUE;
}

/** Location id for a row location select value (Unassigned = null). */
export function locationIdFromSelect(value: string): string | null {
  return value === UNASSIGNED_SELECT_VALUE || value === "" ? null : value;
}

export function movedToast(name: string, locationName: string): string {
  return `${name} moved to ${locationName}`;
}

export function slotsInUse(used: number, limit: number): string {
  return `${used} of ${limit} device slots in use`;
}

export function resetsLeftText(left: number, perYear: number): string {
  return `${left} of ${perYear} self-service deactivations left this year`;
}

/** Fleet footer: "3 devices shown · fingerprints are hashed on the device; we never collect files or billing data". */
export function devicesFooter(shown: number): string {
  return `${plural(shown, "device", "devices")} shown · fingerprints are hashed on the device; we never collect files or billing data`;
}

/** "Windows 11 Pro · v4.2.1" (the app version stands in for the prototype's fingerprint, which the API never sends). */
export function deviceSubtitle(device: Pick<AccountDevice, "os" | "appVersion">): string {
  return device.appVersion ? `${device.os} · v${device.appVersion}` : device.os;
}

export const DEVICES_CSV_FILE = "devices.csv";

/** devices.csv in the prototype's column order; dates as IST YYYY-MM-DD. */
export const DEVICE_CSV_COLUMNS: readonly CsvColumn<AccountDevice>[] = [
  { header: "Device", value: (d) => d.name },
  { header: "OS", value: (d) => d.os },
  { header: "License", value: (d) => d.licenseId },
  { header: "Product", value: (d) => d.productShortName },
  { header: "Location", value: (d) => d.locationName },
  { header: "Activated", value: (d) => istIsoDate(d.activatedAt) },
  { header: "Last seen", value: (d) => istIsoDate(d.lastSeenAt) },
  { header: "Status", value: (d) => DEVICE_STATE_META[deviceState(d)].label },
];
