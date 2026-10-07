/**
 * Pure parts of the portal F3 modules: email preferences (defaults, DPDP consent times), Overview helpers (IST months,
 * financial year, timeline positions, refund netting, spend bars, alert copy), orders (summary, placed-by label,
 * accountant CSV cells incl. escaping and the formula guard), notification links and export attachments.
 */
import { describe, expect, it } from "vitest";
import { csvRow } from "@/lib/csv";
import { DAY_MS } from "@/lib/dates";
import { exportAttachments } from "@/lib/portal/export";
import { safeNotificationHref } from "@/lib/portal/notifications";
import {
  ORDER_CSV_COLUMNS,
  istIsoDate,
  orderItemsSummary,
  placedByLabel,
} from "@/lib/portal/orders";
import {
  daysText,
  deviceLimitAlert,
  expiredAlert,
  expiringAlert,
  financialYearStart,
  netLineAmounts,
  renewalMonths,
  spendBars,
  ticketWaitingAlert,
  timelinePosition,
} from "@/lib/portal/overview";
import { applyEmailPrefsPatch, readStoredEmailPrefs, toEmailPrefs } from "@/lib/portal/preferences";

const NOW = new Date("2026-10-07T06:30:00.000Z"); // 12:00 IST

describe("email preferences", () => {
  it("defaults to renewals, updates and tickets on, offers off", () => {
    expect(toEmailPrefs(readStoredEmailPrefs(null))).toEqual({
      renewals: true,
      updates: true,
      tickets: true,
      offers: false,
      offersConsentAt: null,
    });
    // Malformed values take the defaults; offers without a consent time count as off.
    expect(toEmailPrefs(readStoredEmailPrefs({ renewals: "no", offers: true }))).toMatchObject({ renewals: true, offers: false });
  });

  it("records the consent time when offers turn on and the withdrawal when they turn off", () => {
    const on = applyEmailPrefsPatch(readStoredEmailPrefs({}), { offers: true, tickets: false }, NOW);
    expect(on).toMatchObject({ offers: true, tickets: false, offersConsentAt: NOW.toISOString(), offersWithdrawnAt: null });
    const later = new Date(NOW.getTime() + DAY_MS);
    // Switching it on again keeps the original consent time.
    expect(applyEmailPrefsPatch(on, { offers: true }, later).offersConsentAt).toBe(NOW.toISOString());
    const off = applyEmailPrefsPatch(on, { offers: false }, later);
    expect(off).toMatchObject({ offers: false, offersConsentAt: null, offersWithdrawnAt: later.toISOString() });
    expect(readStoredEmailPrefs(JSON.parse(JSON.stringify(off)))).toEqual(off);
  });
});

describe("overview helpers", () => {
  it("counts IST months and the Indian financial year", () => {
    // 31 Mar 2027 20:00 UTC is already 1 Apr 2027 in IST.
    const edge = new Date("2027-03-31T20:00:00.000Z");
    expect(renewalMonths(edge)[0]).toEqual({ key: "2027-04", label: "Apr" });
    expect(financialYearStart(edge).toISOString()).toBe("2027-03-31T18:30:00.000Z");
    expect(financialYearStart(NOW).toISOString()).toBe("2026-03-31T18:30:00.000Z");
    const months = renewalMonths(NOW);
    expect(months).toHaveLength(12);
    expect(months.map((m) => m.label).join(" ")).toBe("Oct Nov Dec Jan Feb Mar Apr May Jun Jul Aug Sep");
    expect(months[3]).toEqual({ key: "2027-01", label: "Jan" });
  });

  it("places renewal dots from the start of the IST month, clamped to 2-98%", () => {
    const monthStart = new Date("2026-09-30T18:30:00.000Z"); // 1 Oct 2026 00:00 IST
    expect(timelinePosition(new Date(monthStart.getTime() + 73 * DAY_MS), NOW)).toBe(20);
    expect(timelinePosition(new Date(monthStart.getTime() + DAY_MS), NOW)).toBe(2);
    expect(timelinePosition(new Date(monthStart.getTime() + 400 * DAY_MS), NOW)).toBe(98);
  });

  it("nets refunds across order lines by largest remainder", () => {
    expect(netLineAmounts([590_000, 295_000], 0)).toEqual([590_000, 295_000]);
    const net = netLineAmounts([100, 100, 100], 100);
    expect(net.reduce((a, b) => a + b, 0)).toBe(200);
    expect(netLineAmounts([100, 100, 100], 100)).toEqual([66, 67, 67]);
    expect(netLineAmounts([500, 0], 900)).toEqual([0, 0]);
    expect(netLineAmounts([], 100)).toEqual([]);
  });

  it("sizes spend bars against the largest product, at least 4%", () => {
    const bars = spendBars([
      { id: "a", amountPaise: 1_000 },
      { id: "b", amountPaise: 100_000 },
      { id: "c", amountPaise: 0 },
      { id: "d", amountPaise: 50_000 },
    ]);
    expect(bars.map((b) => [b.id, b.barPct])).toEqual([
      ["b", 100],
      ["d", 50],
      ["a", 4],
    ]);
  });

  it("builds alert copy in the prototype wording", () => {
    const license = {
      id: "LIC-24017",
      productId: "medical-billing",
      productShortName: "Medical",
      isTrial: false,
      expiresAt: new Date(NOW.getTime() + 20 * DAY_MS),
      updatesUntil: new Date(NOW.getTime() + 20 * DAY_MS),
      renewal: null,
    };
    expect(expiringAlert(license, 0, NOW)).toMatchObject({
      kind: "expiring",
      title: "Medical ends in 20 days.",
      body: "Renew LIC-24017 to keep billing without interruption.",
      cta: { label: "Renew now", href: "/account/licenses/LIC-24017?tab=renew" },
    });
    expect(daysText(1)).toBe("1 day");
    expect(ticketWaitingAlert({ id: "T-3018", subject: "Printer" }, 2)).toMatchObject({
      title: "Support is waiting for your reply.",
      body: "T-3018 \u00b7 Printer",
      cta: { label: "Open ticket", href: "/account/tickets/T-3018" },
      more: 2,
    });
    expect(deviceLimitAlert("LIC-24017", 0)).toMatchObject({
      title: "LIC-24017 has no free device slots.",
      body: "Deactivate a computer or add one before installing on a new PC.",
      cta: { label: "Manage devices", href: "/account/licenses/LIC-24017?tab=devices" },
    });
    const trial = { ...license, isTrial: true, expiresAt: new Date("2026-10-01T06:30:00.000Z") };
    expect(expiredAlert(trial, 0)).toMatchObject({ title: "Your Medical trial ended on 1 Oct 2026.", cta: { label: "Buy a license" } });
  });
});

describe("orders", () => {
  it("summarises items and who placed the order", () => {
    expect(
      orderItemsSummary([
        { productShortName: "Medical", planName: "Annual", qty: 1 },
        { productShortName: "Restaurant", planName: "Terminal", qty: 3 },
      ]),
    ).toBe("Medical \u00b7 Annual, Restaurant \u00b7 Terminal \u00d73");
    expect(placedByLabel(null)).toBe("Guest checkout");
    expect(placedByLabel({ name: "Rohan Sharma" })).toBe("by Rohan Sharma");
    expect(placedByLabel({ name: " " })).toBe("by account");
  });

  it("writes accountant CSV cells: IST dates, rupees with 2 decimals, quotes escaped, formulas guarded", () => {
    const order = {
      id: "AX-10301",
      status: "PARTIALLY_REFUNDED",
      createdAt: new Date("2026-03-31T19:00:00.000Z"), // 1 Apr 2026 00:30 IST
      paidAt: null,
      taxablePaise: 499_900,
      cgstPaise: 44_991,
      sgstPaise: 44_991,
      igstPaise: 0,
      totalPaise: 589_882,
      placeOfSupply: '=HYPERLINK("http://evil.example")',
      billing: { gstin: "27ABCDE1234F1Z5" },
      placedBy: null,
      invoice: { number: "AXS/26-27/1181", issuedAt: new Date("2026-04-02T05:00:00.000Z"), seller: { gstin: "29AAACA1234B1Z2" } },
      items: [],
    };
    const cells = ORDER_CSV_COLUMNS.map((c) => c.value(order as never));
    expect(ORDER_CSV_COLUMNS.map((c) => c.header)).toEqual([
      "Order",
      "Date",
      "Invoice",
      "Status",
      "Taxable",
      "CGST",
      "SGST",
      "IGST",
      "Total",
      "Invoice date",
      "Place of supply",
      "Billed GSTIN",
      "Seller GSTIN",
    ]);
    expect(cells).toEqual([
      "AX-10301",
      "2026-04-01",
      "AXS/26-27/1181",
      "Partly refunded",
      "4999.00",
      "449.91",
      "449.91",
      "0.00",
      "5898.82",
      "2026-04-02",
      '=HYPERLINK("http://evil.example")',
      "27ABCDE1234F1Z5",
      "29AAACA1234B1Z2",
    ]);
    expect(csvRow(cells)).toBe(
      '"AX-10301","2026-04-01","AXS/26-27/1181","Partly refunded","4999.00","449.91","449.91","0.00","5898.82","2026-04-02",' +
        '"\'=HYPERLINK(""http://evil.example"")","27ABCDE1234F1Z5","29AAACA1234B1Z2"',
    );
    expect(istIsoDate(null)).toBe("");
  });
});

describe("notification links and export attachments", () => {
  it("keeps only same-site relative links", () => {
    expect(safeNotificationHref("/account/licenses/LIC-24017")).toBe("/account/licenses/LIC-24017");
    expect(safeNotificationHref("https://evil.example/")).toBeNull();
    expect(safeNotificationHref("//evil.example/")).toBeNull();
    expect(safeNotificationHref("/\\evil.example")).toBeNull();
    expect(safeNotificationHref("/a b")).toBeNull();
    expect(safeNotificationHref(null)).toBeNull();
  });

  it("exports attachment names and sizes, never storage keys", () => {
    expect(
      exportAttachments([
        { name: "screen.png", sizeBytes: 1200, storageKey: "uploads/acc/secret.png" },
        { sizeBytes: 5 },
        "junk",
      ]),
    ).toEqual([{ name: "screen.png", sizeBytes: 1200 }]);
    expect(exportAttachments(null)).toEqual([]);
  });
});
