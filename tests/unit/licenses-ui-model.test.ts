import { describe, expect, it } from "vitest";
import {
  cartMaxQty,
  countNoun,
  deviceUsage,
  filterLicenses,
  historyLine,
  intervalUnit,
  istIsoDate,
  LICENSE_CSV_COLUMNS,
  licenseFacts,
  licenseHref,
  licenseProductOptions,
  licensesFooter,
  licenseStatusOptions,
  optionLine,
  parseLicenseTab,
  primaryOption,
  renewalCardCopy,
  renewalSelection,
  sortLicenses,
  statusExplanation,
  termInfo,
  type DetailLicense,
  type LicenseListRow,
} from "@/components/account/licenses/model";
import { toCsv } from "@/lib/csv";
import type { RenewalOption } from "@/lib/licensing/account";

const NOW = new Date("2026-10-07T06:30:00.000Z");
const DAY = 86_400_000;
const iso = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

function row(over: Partial<LicenseListRow> & { id: string }): LicenseListRow {
  return {
    productId: "medical-billing",
    productName: "Medical Store Billing Software",
    productShortName: "Medical Store Billing",
    productIcon: "medication",
    productTone: "sage",
    planId: "med-annual",
    planName: "Annual license",
    planType: "ANNUAL",
    keyMasked: "MED-••••-••••-••••-K8NM",
    keyLast4: "K8NM",
    status: "active",
    issuedAt: iso(-300),
    expiresAt: iso(65),
    updatesUntil: iso(65),
    deviceLimit: 3,
    devicesUsed: 1,
    orderId: "AX-10198",
    renewal: null,
    ...over,
  };
}

const ROWS: LicenseListRow[] = [
  row({ id: "LIC-24017", status: "expiring", expiresAt: iso(41), devicesUsed: 2 }),
  row({
    id: "LIC-24112",
    productId: "general-store-gst",
    productName: "General Store GST Billing Software",
    productShortName: "General Store GST Billing",
    keyLast4: "R2KC",
    status: "expired",
    planType: "TRIAL",
    expiresAt: iso(-25),
    devicesUsed: 0,
    deviceLimit: 1,
  }),
  row({ id: "LIC-23961", productShortName: "Cheque Printing", productName: "Cheque Printing Software", productId: "cheque-printing", expiresAt: null, devicesUsed: 1, deviceLimit: 1, keyLast4: "J3XV" }),
  row({ id: "LIC-24188", status: "revoked", expiresAt: iso(345), keyLast4: "M4EB" }),
];

describe("license list filters", () => {
  it("filters by derived status, product and search (id, product name, last 4 of the key)", () => {
    expect(filterLicenses(ROWS, { q: "", status: "expired", product: "all" }).map((r) => r.id)).toEqual(["LIC-24112"]);
    expect(filterLicenses(ROWS, { q: "", status: "all", product: "cheque-printing" }).map((r) => r.id)).toEqual(["LIC-23961"]);
    expect(filterLicenses(ROWS, { q: "r2kc", status: "all", product: "all" }).map((r) => r.id)).toEqual(["LIC-24112"]);
    expect(filterLicenses(ROWS, { q: "medical 24017", status: "all", product: "all" }).map((r) => r.id)).toEqual(["LIC-24017"]);
    expect(filterLicenses(ROWS, { q: "nothing", status: "all", product: "all" })).toEqual([]);
  });

  it("offers Suspended only when the account has a suspended license", () => {
    expect(licenseStatusOptions(ROWS).map((o) => o.label)).toEqual(["All", "Active", "Expiring soon", "Trial", "Expired", "Revoked"]);
    expect(licenseStatusOptions([...ROWS, row({ id: "LIC-1", status: "suspended" })]).at(-1)).toEqual({ value: "suspended", label: "Suspended" });
    expect(licenseProductOptions([{ id: "cheque-printing", shortName: "Cheque Printing" }])).toEqual([
      { value: "all", label: "All products" },
      { value: "cheque-printing", label: "Cheque Printing" },
    ]);
  });
});

describe("license list sorting", () => {
  it("sorts by expiry ascending by default with perpetual licenses last, and flips descending", () => {
    expect(sortLicenses(ROWS, null).map((r) => r.id)).toEqual(["LIC-24112", "LIC-24017", "LIC-24188", "LIC-23961"]);
    expect(sortLicenses(ROWS, { id: "expiry", desc: true }).map((r) => r.id)).toEqual(["LIC-23961", "LIC-24188", "LIC-24017", "LIC-24112"]);
  });

  it("sorts by product, status rank, device usage and updates; ties by id; unknown ids fall back to expiry", () => {
    expect(sortLicenses(ROWS, { id: "product", desc: false }).map((r) => r.productShortName)[0]).toBe("Cheque Printing");
    expect(sortLicenses(ROWS, { id: "status", desc: false }).map((r) => r.status)).toEqual(["active", "expiring", "expired", "revoked"]);
    expect(sortLicenses(ROWS, { id: "devices", desc: true }).map((r) => r.id)[0]).toBe("LIC-23961");
    expect(sortLicenses(ROWS, { id: "nope", desc: true })).toEqual(sortLicenses(ROWS, null));
    const tie = [row({ id: "LIC-2" }), row({ id: "LIC-1" })];
    expect(sortLicenses(tie, { id: "product", desc: true }).map((r) => r.id)).toEqual(["LIC-1", "LIC-2"]);
  });
});

describe("cells and footer", () => {
  it("describes the term like the prototype, with grammar fixes", () => {
    expect(termInfo(null, NOW)).toEqual({ label: "No end date", sub: "One-time license", warn: false });
    expect(termInfo(iso(41), NOW)).toEqual({ label: "17 Nov 2026", sub: "41 days left", warn: true });
    expect(termInfo(iso(345), NOW).warn).toBe(false);
    expect(termInfo(iso(0.5), NOW).sub).toBe("1 day left");
    expect(termInfo(iso(-25), NOW)).toEqual({ label: "12 Sep 2026", sub: "Ended 25 days ago", warn: true });
    expect(termInfo(iso(-0.2), NOW).sub).toBe("Ended today");
  });

  it("reports device usage and the full bar", () => {
    expect(deviceUsage(2, 3)).toEqual({ label: "2 / 3", pct: 66.7, full: false });
    expect(deviceUsage(1, 1)).toEqual({ label: "1 / 1", pct: 100, full: true });
    expect(deviceUsage(4, 3).pct).toBe(100);
    expect(deviceUsage(0, 0)).toEqual({ label: "0 / 0", pct: 0, full: false });
  });

  it("writes the footer and IST dates", () => {
    expect(licensesFooter(4, 6)).toBe("4 of 6 licenses · keys are masked; open a license to reveal");
    expect(licensesFooter(1, 1)).toBe("1 of 1 license · keys are masked; open a license to reveal");
    expect(istIsoDate("2026-11-16T20:00:00.000Z")).toBe("2026-11-17");
    expect(istIsoDate(null)).toBe("");
  });

  it("exports licenses.csv in the prototype's columns with labels and IST dates", () => {
    const csv = toCsv([ROWS[0] as LicenseListRow, ROWS[2] as LicenseListRow], LICENSE_CSV_COLUMNS, { bom: false });
    const [header, first, second] = csv.split("\r\n");
    expect(header).toBe('"License","Product","Plan","Status","Expires","Updates until","Devices used","Device limit","Key (last 4)"');
    expect(first).toBe('"LIC-24017","Medical Store Billing Software","Annual license","Expiring soon","2026-11-17","2026-12-11","2","3","K8NM"');
    expect(second).toContain('"No end date"');
  });
});

const option = (over: Partial<RenewalOption>): RenewalOption => ({
  tag: "RENEWAL",
  kind: "RENEWAL",
  planId: "med-annual",
  planName: "Annual license",
  planType: "ANNUAL",
  interval: "YEAR",
  qty: 1,
  unitPricePaise: 499_900,
  pricePaise: 499_900,
  from: iso(41),
  available: true,
  ...over,
});

describe("cart lines", () => {
  it("caps quantities like the server's normalizeQuantity", () => {
    expect(cartMaxQty({ type: "ANNUAL", perUnit: null, maxQty: null })).toBe(1);
    expect(cartMaxQty({ type: "ANNUAL", perUnit: "terminal", maxQty: null })).toBe(10);
    expect(cartMaxQty({ type: "SUBSCRIPTION", perUnit: "terminal", maxQty: 25 })).toBe(25);
    expect(cartMaxQty({ type: "DEVICE_ADDON", perUnit: null, maxQty: 4 })).toBe(4);
    expect(cartMaxQty({ type: "MAINTENANCE", perUnit: "terminal", maxQty: 9 })).toBe(1);
  });

  it("builds the line of an option for its license, never below the option's quantity", () => {
    expect(optionLine(option({}), "LIC-24017", { type: "ANNUAL", perUnit: null, maxQty: null })).toEqual({
      planId: "med-annual",
      qty: 1,
      maxQty: 1,
      kind: "RENEWAL",
      targetLicenseId: "LIC-24017",
    });
    expect(optionLine(option({ qty: 3 }), "LIC-1", null).maxQty).toBe(3);
    expect(optionLine(option({ qty: 3 }), "LIC-1", { type: "ANNUAL", perUnit: "terminal", maxQty: null }).maxQty).toBe(10);
  });

  it("picks renewal, maintenance or a trial's conversion as the primary option", () => {
    expect(primaryOption([option({ tag: "ADD-ON", kind: "ADDON" }), option({ tag: "MAINTENANCE" })])?.tag).toBe("MAINTENANCE");
    expect(primaryOption([option({ tag: "BUY", kind: "UPGRADE" })])?.kind).toBe("UPGRADE");
    expect(primaryOption([option({ tag: "UPGRADE", kind: "UPGRADE" })])).toBeNull();
  });

  it("renews the selected licenses that have a renewal line and counts the rest as skipped", () => {
    const line = { planId: "med-annual", qty: 1, maxQty: 1, kind: "RENEWAL" as const, targetLicenseId: "LIC-24017" };
    const rows = [
      row({ id: "LIC-24017", renewal: line }),
      row({ id: "LIC-24188", status: "revoked", renewal: { ...line, targetLicenseId: "LIC-24188" } }),
      row({ id: "LIC-9" }),
    ];
    expect(renewalSelection(rows, ["LIC-24017", "LIC-24188"])).toEqual({ lines: [line], skipped: 1 });
    expect(renewalSelection(rows, ["LIC-9", "LIC-404"])).toEqual({ lines: [], skipped: 1 });
  });
});

function detail(over: Partial<DetailLicense>): DetailLicense {
  return {
    id: "LIC-24017",
    productShortName: "Medical Store Billing",
    planName: "Annual license",
    planType: "ANNUAL",
    status: "active",
    issuedAt: iso(-324),
    expiresAt: iso(200),
    updatesUntil: iso(200),
    deviceLimit: 3,
    devicesUsed: 2,
    orderId: "AX-10198",
    unit: "computer",
    revokedReason: null,
    selfServiceResetsLeft: 2,
    selfServiceResetsPerYear: 3,
    ...over,
  };
}

describe("status explanation", () => {
  it("uses the prototype's words for each status", () => {
    expect(statusExplanation(detail({}), NOW)).toMatchObject({
      tone: "sage",
      icon: "verified",
      title: "What this license covers",
      body: "You can use Medical Store Billing on up to 3 computers until 25 Apr 2027. Updates and support are included until then.",
    });
    expect(statusExplanation(detail({ status: "expiring", expiresAt: iso(41) }), NOW)).toMatchObject({
      tone: "peach",
      title: "Ends in 41 days",
      body: "You can use Medical Store Billing on up to 3 computers until 17 Nov 2026. Renew before then to keep billing without a break. Your data stays on your computers either way.",
    });
    expect(statusExplanation(detail({ status: "expired", planType: "TRIAL", expiresAt: iso(-25), deviceLimit: 1 }), NOW)).toMatchObject({
      title: "Trial ended",
      body: "It ended on 12 Sep 2026. The software can no longer create new bills, but your data is safe. Buy a license to continue.",
    });
    expect(statusExplanation(detail({ status: "expired", expiresAt: iso(-25) }), NOW).body).toMatch(/Renew to continue where you left off\.$/);
    expect(statusExplanation(detail({ status: "revoked", revokedReason: "Order AX-10288 was refunded at your request." }), NOW).body).toBe(
      "Order AX-10288 was refunded at your request. It can’t be activated on any computer. Contact support if you think this is a mistake.",
    );
    expect(statusExplanation(detail({ status: "revoked" }), NOW).body).toMatch(/^It can’t be activated/);
    expect(statusExplanation(detail({ status: "suspended" }), NOW).body).toBe("Activations are paused. Contact support to restore it.");
    expect(statusExplanation(detail({ status: "trial", planType: "TRIAL", deviceLimit: 1, expiresAt: iso(10) }), NOW)).toMatchObject({
      tone: "blue",
      title: "Free trial",
      body: "All features on 1 computer until 17 Oct 2026.",
    });
  });

  it("explains one-time licenses with and without updates", () => {
    expect(statusExplanation(detail({ expiresAt: null, updatesUntil: iso(-195), deviceLimit: 1 }), NOW).body).toBe(
      "You can use Medical Store Billing on up to 1 computer with no end date. Updates ended on 26 Mar 2026; the software keeps working, and you can renew maintenance for newer versions.",
    );
    expect(statusExplanation(detail({ expiresAt: null, unit: "terminal" }), NOW).body).toBe(
      "You can use Medical Store Billing on up to 3 terminals with no end date. Updates are included until 25 Apr 2027.",
    );
  });
});

describe("facts, cards and history", () => {
  it("lists the facts grid", () => {
    const facts = licenseFacts(detail({}), NOW);
    expect(facts.map((f) => [f.label, f.value, f.sub])).toEqual([
      ["Plan", "Annual license", "Annual"],
      ["Issued", "17 Nov 2025", "Order AX-10198"],
      ["Valid until", "25 Apr 2027", ""],
      ["Updates until", "25 Apr 2027", "Included"],
      ["Device limit", "3 computers", "2 in use"],
      ["Self-service resets", "2 of 3 left", "Resets yearly"],
    ]);
    expect(facts[1]?.orderId).toBe("AX-10198");
    const trial = licenseFacts(detail({ status: "expired", planType: "TRIAL", orderId: null, expiresAt: iso(-25), updatesUntil: iso(-25) }), NOW);
    expect(trial[1]?.sub).toBe("Trial");
    expect(trial[2]?.label).toBe("Ended");
    expect(trial[3]?.sub).toBe("Ended");
    expect(licenseFacts(detail({ expiresAt: null }), NOW)[2]).toMatchObject({ value: "No end date", sub: "One-time license" });
  });

  it("writes the Renew & upgrade cards", () => {
    expect(renewalCardCopy(option({}), { deviceLimit: 3 })).toEqual({
      title: "Renew annual license",
      body: "Extends the term from 17 Nov 2026. Devices and key stay the same.",
      unit: "/year",
      cta: "Add to cart",
      action: "cart",
    });
    expect(renewalCardCopy(option({ tag: "MAINTENANCE", from: iso(0) }), { deviceLimit: 1 }).body).toBe(
      "Another 12 months of updates and priority support from 7 Oct 2026.",
    );
    expect(renewalCardCopy(option({ tag: "ADD-ON", kind: "ADDON" }), { deviceLimit: 3 })).toMatchObject({
      body: "Raise the device limit from 3. Charged per computer.",
      cta: "Choose quantity",
      action: "addon",
    });
    expect(renewalCardCopy(option({ tag: "BUY", kind: "UPGRADE" }), { deviceLimit: 1 })).toMatchObject({ cta: "Choose plan", action: "choose" });
    expect(renewalCardCopy(option({ tag: "UPGRADE", kind: "UPGRADE", interval: null }), { deviceLimit: 1 }).unit).toBe("one-time");
    expect(intervalUnit("MONTH")).toBe("/month");
  });

  it("formats history lines with the member as You", () => {
    expect(historyLine({ type: "key_revealed", label: "Key revealed", actor: "Priya Sharma", detail: null }, "Priya Sharma")).toEqual({
      what: "Key revealed",
      who: "You",
    });
    expect(historyLine({ type: "activated", label: "Activated", actor: "Device", detail: "Back office laptop" }, "Priya Sharma")).toEqual({
      what: "Activated",
      who: "Back office laptop",
    });
    expect(historyLine({ type: "deactivated", label: "Deactivated", actor: "Rohan Sharma", detail: "Old counter PC" }, "Priya Sharma").who).toBe(
      "Old counter PC · Rohan Sharma",
    );
    expect(historyLine({ type: "trial_ended", label: "Trial ended", actor: "System", detail: null }, "Priya Sharma").who).toBe("");
  });

  it("reads the member's own deactivation as the prototype's \"Deactivated by you · {device}\"", () => {
    expect(historyLine({ type: "deactivated", label: "Deactivated", actor: "Priya Sharma", detail: "Old counter PC" }, "Priya Sharma")).toEqual({
      what: "Deactivated by you",
      who: "Old counter PC",
    });
    expect(historyLine({ type: "deactivated", label: "Deactivated", actor: "Priya Sharma", detail: null }, "Priya Sharma")).toEqual({
      what: "Deactivated by you",
      who: "",
    });
    // A device-made or staff deactivation keeps the label.
    expect(historyLine({ type: "deactivated", label: "Deactivated", actor: "System", detail: "Old counter PC" }, "Priya Sharma").what).toBe(
      "Deactivated",
    );
  });

  it("parses the tab and builds license links", () => {
    expect(parseLicenseTab("devices")).toBe("devices");
    expect(parseLicenseTab(["renew", "x"])).toBe("renew");
    expect(parseLicenseTab("plans")).toBe("overview");
    expect(parseLicenseTab(undefined)).toBe("overview");
    expect(licenseHref("LIC-24017")).toBe("/account/licenses/LIC-24017");
    expect(licenseHref("LIC-24017", "activity")).toBe("/account/licenses/LIC-24017?tab=activity");
    expect(countNoun(1, "terminal")).toBe("1 terminal");
  });
});
