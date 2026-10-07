import { describe, expect, it } from "vitest";
import {
  bulkDeactivateCopy,
  deactivatedToast,
  DEVICE_CSV_COLUMNS,
  deviceIcon,
  deviceNames,
  devicesFooter,
  deviceState,
  deviceSubtitle,
  filterDevices,
  isDeactivatable,
  lastSeenText,
  locationFilterOptions,
  movedToast,
  parseDeviceStatus,
  planDeactivation,
  resetsLeftText,
  singleDeactivateCopy,
  skippedDevicesNote,
  slotsInUse,
  type DeviceRow,
} from "@/components/account/devices/model";
import { toCsv } from "@/lib/csv";

const NOW = new Date("2026-10-07T06:30:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function device(over: Partial<DeviceRow> & { id: string }): DeviceRow {
  return {
    name: "Billing counter PC",
    os: "Windows 11 Pro",
    appVersion: "4.2.1",
    licenseId: "LIC-24017",
    productId: "medical-billing",
    productName: "Medical Store Billing Software",
    productShortName: "Medical Store Billing",
    locationId: "loc1",
    locationName: "FC Road (main store)",
    activatedAt: ago(320),
    lastSeenAt: ago(0.1),
    deactivatedAt: null,
    deactivatedBy: null,
    active: true,
    stale: false,
    canDeactivate: true,
    licenseUsable: true,
    ...over,
  };
}

const FLEET: DeviceRow[] = [
  device({ id: "d1" }),
  device({ id: "d2", name: "Back office laptop", os: "Windows 10 Home", appVersion: null, locationId: "loc2", locationName: "Kothrud branch" }),
  device({ id: "d3", name: "Accounts PC", licenseId: "LIC-23961", productShortName: "Cheque Printing", stale: true, lastSeenAt: ago(40) }),
  device({ id: "d0", name: "Old counter PC", active: false, deactivatedAt: ago(200), locationId: null, locationName: "Unassigned" }),
];

describe("device states and cells", () => {
  it("derives the badge state and the icon", () => {
    expect(FLEET.map(deviceState)).toEqual(["active", "active", "stale", "deactivated"]);
    expect(deviceIcon({ os: "Android 14", name: "Store tablet" })).toBe("smartphone");
    expect(deviceIcon({ os: "Windows 10", name: "Back office laptop" })).toBe("laptop");
    expect(deviceIcon({ os: "Windows 11", name: "Billing counter PC" })).toBe("desktop_windows");
    expect(deviceSubtitle(FLEET[0] as DeviceRow)).toBe("Windows 11 Pro · v4.2.1");
    expect(deviceSubtitle(FLEET[1] as DeviceRow)).toBe("Windows 10 Home");
    expect(lastSeenText(FLEET[2] as DeviceRow, NOW)).toBe("40d ago");
  });

  it("allows deactivation for active devices on usable licenses only", () => {
    expect(isDeactivatable(device({ id: "a" }))).toBe(true);
    expect(isDeactivatable(device({ id: "b", active: false }))).toBe(false);
    expect(isDeactivatable(device({ id: "c", licenseUsable: false }))).toBe(false);
  });
});

describe("fleet filters", () => {
  it("filters by the status tab, location and search", () => {
    const ids = (f: { q?: string; status?: string; location?: string }) =>
      filterDevices(FLEET, { q: f.q ?? "", status: f.status ?? "active", location: f.location ?? "all" }).map((d) => d.id);
    expect(ids({})).toEqual(["d1", "d2", "d3"]);
    expect(ids({ status: "stale" })).toEqual(["d3"]);
    expect(ids({ status: "inactive" })).toEqual(["d0"]);
    expect(ids({ status: "all", location: "none" })).toEqual(["d0"]);
    expect(ids({ status: "all", location: "loc2" })).toEqual(["d2"]);
    expect(ids({ q: "lic-23961" })).toEqual(["d3"]);
    expect(ids({ q: "windows 10" })).toEqual(["d2"]);
    expect(parseDeviceStatus("bogus")).toBe("active");
  });

  it("offers every location plus Unassigned", () => {
    expect(locationFilterOptions([{ id: "loc1", name: "FC Road" }])).toEqual([
      { value: "all", label: "All locations" },
      { value: "loc1", label: "FC Road" },
      { value: "none", label: "Unassigned" },
    ]);
  });
});

describe("bulk deactivation plan", () => {
  it("keeps each license within its self-service deactivations left and skips inactive devices", () => {
    const selected = [
      device({ id: "a1" }),
      device({ id: "a2" }),
      device({ id: "a3" }),
      device({ id: "b1", licenseId: "LIC-2" }),
      device({ id: "x", active: false }),
      device({ id: "y", licenseUsable: false }),
    ];
    const plan = planDeactivation(selected, { "LIC-24017": 2, "LIC-2": 0 });
    expect(plan.run.map((d) => d.id)).toEqual(["a1", "a2"]);
    expect(plan.skipped.map((d) => d.id)).toEqual(["a3", "b1", "x", "y"]);
    expect(planDeactivation([device({ id: "z", licenseId: "LIC-404" })], {}).run).toHaveLength(1);
  });
});

describe("copy", () => {
  it("words the dialogs and toasts like the prototype", () => {
    expect(bulkDeactivateCopy(["Billing counter PC"], 3)).toEqual({
      title: "Deactivate 1 device?",
      body: "Software on Billing counter PC will stop working until activated again. Each deactivation uses one of the license’s 3 yearly self-service resets.",
    });
    expect(bulkDeactivateCopy(["A", "B"], 3).title).toBe("Deactivate 2 devices?");
    expect(deviceNames(["A", "B", "C", "D", "E", "F", "G"])).toBe("A, B, C, D, E and 2 more");
    expect(singleDeactivateCopy("Billing counter PC", 1)).toEqual({
      title: "Deactivate “Billing counter PC”?",
      body: "The software on this computer stops working until it’s activated again. You have 1 self-service deactivation left this year.",
    });
    expect(singleDeactivateCopy("X", 2).body).toMatch(/You have 2 self-service deactivations left this year\.$/);
    expect(deactivatedToast(1, false)).toBe("1 device deactivated");
    expect(deactivatedToast(3, true)).toBe("3 devices deactivated · some were skipped");
    expect(skippedDevicesNote(1)).toMatch(/^1 selected device can’t be deactivated now/);
    expect(movedToast("Accounts PC", "Kothrud branch")).toBe("Accounts PC moved to Kothrud branch");
    expect(slotsInUse(2, 3)).toBe("2 of 3 device slots in use");
    expect(resetsLeftText(2, 3)).toBe("2 of 3 self-service deactivations left this year");
    expect(devicesFooter(1)).toBe("1 device shown · fingerprints are hashed on the device; we never collect files or billing data");
  });

  it("exports devices.csv in the prototype's columns", () => {
    const csv = toCsv(FLEET.slice(2), DEVICE_CSV_COLUMNS, { bom: false }).split("\r\n");
    expect(csv[0]).toBe('"Device","OS","License","Product","Location","Activated","Last seen","Status"');
    expect(csv[1]).toBe(
      '"Accounts PC","Windows 11 Pro","LIC-23961","Cheque Printing","FC Road (main store)","2025-11-21","2026-08-28","Not seen recently"',
    );
    expect(csv[2]).toContain('"Deactivated"');
  });
});
