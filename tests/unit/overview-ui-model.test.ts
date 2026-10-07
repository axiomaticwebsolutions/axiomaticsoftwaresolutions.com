import { describe, expect, it } from "vitest";
import {
  activityLine,
  activityVisual,
  alertAction,
  alertMoreText,
  daysText,
  dotLeft,
  iconOr,
  kpiCards,
  lowerFirst,
  moreText,
  OVERVIEW_COPY,
  renewalPrice,
  renewalWhen,
  slotAriaLabel,
  slotBar,
  slotLabel,
  timelineAriaLabel,
  timelineDotTitle,
} from "@/components/account/overview/model";
import { toTone, toneClasses, TONE_CLASSES } from "@/components/account/overview/tones";
import type { OverviewAlert, OverviewKpis } from "@/lib/portal/overview";
import type { RenewalOption } from "@/lib/licensing/account";

const renewal: RenewalOption = {
  tag: "RENEWAL",
  kind: "RENEWAL",
  planId: "med-annual",
  planName: "Annual license",
  planType: "ANNUAL",
  interval: "YEAR",
  qty: 1,
  unitPricePaise: 499_900,
  pricePaise: 499_900,
  from: "2026-11-17T03:32:10.572Z",
  available: true,
};

const kpis: OverviewKpis = {
  licenses: { active: 2, total: 4, inactive: 2 },
  deviceSlots: { used: 3, slots: 4, pct: 75, licenses: 2 },
  spend: { last12MonthsPaise: 1_179_646, thisFyPaise: 0, allTimePaise: 1_533_528, fyLabel: "26-27" },
  nextRenewal: { licenseId: "LIC-24017", productShortName: "Medical Store Billing", expiresAt: "2026-11-17T03:32:10.572Z", days: 41 },
};

describe("overview KPI cards (prototype wording)", () => {
  it("builds the four cards in order with values, subs and links", () => {
    const cards = kpiCards(kpis);
    expect(cards.map((c) => c.label)).toEqual(["Active licenses", "Device slots", "Spend \u00b7 12 months", "Next renewal"]);
    expect(cards.map((c) => c.value)).toEqual(["2 of 4", "3 / 4", "\u20b911,796.46", "41 days"]);
    expect(cards[0]?.sub).toBe("2 expired or revoked");
    expect(cards[1]?.sub).toBe("75% in use across 2 licenses");
    expect(cards[2]?.sub).toBe("This FY \u20b90 \u00b7 \u20b915,335.28 all time");
    expect(cards[3]?.sub).toBe("Medical Store Billing \u00b7 17 Nov 2026");
    expect(cards.map((c) => c.href)).toEqual(["/account/licenses", "/account/devices", "/account/orders", "/account/licenses/LIC-24017"]);
    expect(cards.map((c) => c.tone)).toEqual(["lavender", "blue", "sage", "peach"]);
  });

  it("handles no slots, one license, one day and nothing due", () => {
    const cards = kpiCards({
      ...kpis,
      deviceSlots: { used: 0, slots: 0, pct: null, licenses: 0 },
      nextRenewal: null,
    });
    expect(cards[1]?.sub).toBe("No active slots");
    expect(cards[3]).toMatchObject({ value: "\u2014", sub: "Nothing due", href: "/account/licenses" });
    const one = kpiCards({
      ...kpis,
      deviceSlots: { used: 1, slots: 1, pct: 100, licenses: 1 },
      nextRenewal: { ...kpis.nextRenewal!, days: 1 },
    });
    expect(one[1]?.sub).toBe("100% in use across 1 license");
    expect(one[3]?.value).toBe("1 day");
  });

  it("keeps the description and empty-state copy", () => {
    expect(OVERVIEW_COPY.description("Sharma Medicals")).toBe(
      "Sharma Medicals \u00b7 licenses, devices, renewals and spend at a glance.",
    );
    expect(OVERVIEW_COPY.noUtilization).toBe("No active licenses.");
    expect(OVERVIEW_COPY.noRenewals).toBe("Nothing due in the next 12 months.");
  });
});

describe("overview alerts", () => {
  const base: Pick<OverviewAlert, "kind" | "more"> = { kind: "expiring", more: 0 };
  it("says nothing extra for a single case and counts the rest per kind", () => {
    expect(alertMoreText(base)).toBeNull();
    expect(alertMoreText({ kind: "expiring", more: 1 })).toBe("1 more license also ends within 60 days.");
    expect(alertMoreText({ kind: "expiring", more: 2 })).toBe("2 more licenses also end within 60 days.");
    expect(alertMoreText({ kind: "ticket_waiting", more: 3 })).toBe("3 more tickets also need your reply.");
    expect(alertMoreText({ kind: "device_limit", more: 1 })).toBe("1 more license also has no free device slots.");
    expect(alertMoreText({ kind: "updates_ended", more: 2 })).toBe("2 more licenses also need maintenance for newer versions.");
    expect(alertMoreText({ kind: "expired", more: 1 })).toBe("1 more license also ended recently.");
  });

  it("adds renewals to the cart when the alert carries one, else follows the link", () => {
    const cta = { label: "Renew now", href: "/account/licenses/LIC-1?tab=renew", renewal };
    expect(alertAction({ cta, licenseId: "LIC-1" })).toMatchObject({ type: "renewal", licenseId: "LIC-1", label: "Renew now" });
    expect(alertAction({ cta: { ...cta, renewal: null }, licenseId: "LIC-1" })).toEqual({
      type: "link",
      label: "Renew now",
      href: "/account/licenses/LIC-1?tab=renew",
    });
    expect(alertAction({ cta, licenseId: null }).type).toBe("link");
  });
});

describe("device slot segments", () => {
  it("draws one cell per slot, orange when every slot is used", () => {
    expect(slotBar({ used: 2, limit: 3, full: false })).toEqual({ mode: "cells", cells: ["used", "used", "free"] });
    expect(slotBar({ used: 1, limit: 1, full: true })).toEqual({ mode: "cells", cells: ["full"] });
    expect(slotBar({ used: 0, limit: 2, full: false })).toEqual({ mode: "cells", cells: ["free", "free"] });
  });

  it("clamps odd counts and switches to a proportional bar for large limits", () => {
    expect(slotBar({ used: 5, limit: 3, full: true })).toEqual({ mode: "cells", cells: ["full", "full", "full"] });
    expect(slotBar({ used: 25, limit: 50, full: false })).toEqual({ mode: "bar", pct: 50, full: false });
    expect(slotBar({ used: 0, limit: 0, full: false })).toEqual({ mode: "cells", cells: [] });
  });

  it("labels the bar for screen readers", () => {
    expect(slotLabel({ used: 2, limit: 3 })).toBe("2 of 3");
    expect(slotAriaLabel({ used: 2, limit: 3 })).toBe("2 of 3 device slots used");
    expect(slotAriaLabel({ used: 1, limit: 1 })).toBe("1 of 1 device slot used");
  });
});

describe("renewals timeline", () => {
  const item = { licenseId: "LIC-24017", expiresAt: "2026-11-17T03:32:10.572Z", days: 41 };
  it("formats rows, prices and dot titles", () => {
    expect(renewalWhen(item)).toBe("Ends 17 Nov 2026 \u00b7 41 days");
    expect(renewalWhen({ ...item, days: 1 })).toBe("Ends 17 Nov 2026 \u00b7 1 day");
    expect(renewalPrice(renewal)).toBe("\u20b94,999 + GST");
    expect(timelineDotTitle(item)).toBe("LIC-24017 \u00b7 17 Nov 2026");
  });

  it("gives the track a text alternative", () => {
    expect(timelineAriaLabel([])).toBe("Renewal timeline: nothing due in the next 12 months.");
    expect(timelineAriaLabel([item, { licenseId: "LIC-2", expiresAt: "2027-03-01T00:00:00.000Z" }])).toBe(
      "Renewal timeline for the next 12 months: LIC-24017 on 17 Nov 2026, LIC-2 on 1 Mar 2027.",
    );
  });

  it("clamps dot positions to 2-98%", () => {
    expect(dotLeft(13)).toBe("13%");
    expect(dotLeft(0)).toBe("2%");
    expect(dotLeft(120)).toBe("98%");
    expect(dotLeft(Number.NaN)).toBe("2%");
  });
});

describe("recent activity rows", () => {
  const now = new Date("2026-10-07T10:00:00.000Z");
  it("lower-cases the action and picks the kind's icon tile", () => {
    const line = activityLine(
      { id: "a1", at: "2026-10-07T09:00:00.000Z", actorName: "Priya Sharma", action: "Opened ticket", target: "T-3018", kind: "ticket" },
      now,
    );
    expect(line).toMatchObject({ actor: "Priya Sharma", action: "opened ticket", target: "T-3018", when: "1h ago", icon: "support_agent", tone: "blue" });
    expect(line.dateTime).toBe("2026-10-07T09:00:00.000Z");
    expect(activityLine({ ...line, actorName: "x", at: "2026-10-06T08:00:00.000Z", kind: "x", action: "X", id: "a2" }, now).when).toBe(
      "yesterday",
    );
  });

  it("maps every activity kind (prototype actRow)", () => {
    expect(activityVisual("license")).toEqual({ icon: "key", tone: "lavender" });
    expect(activityVisual("team")).toEqual({ icon: "group", tone: "sage" });
    expect(activityVisual("billing")).toEqual({ icon: "receipt_long", tone: "peach" });
    expect(activityVisual("download")).toEqual({ icon: "download", tone: "blue" });
    expect(activityVisual("security")).toEqual({ icon: "shield", tone: "pink" });
    expect(activityVisual("toString")).toEqual({ icon: "history", tone: "lavender" });
  });
});

describe("small helpers", () => {
  it("pluralises days, lower-cases, guards icons and tones", () => {
    expect(daysText(0)).toBe("0 days");
    expect(daysText(1)).toBe("1 day");
    expect(lowerFirst("Downloaded installer")).toBe("downloaded installer");
    expect(lowerFirst("")).toBe("");
    expect(iconOr("medication", "inventory_2")).toBe("medication");
    expect(iconOr("not_an_icon", "inventory_2")).toBe("inventory_2");
    expect(iconOr(null, "inventory_2")).toBe("inventory_2");
    expect(moreText(0, "license")).toBeNull();
    expect(moreText(2, "license")).toBe("+2 more licenses");
    expect(toTone("sage")).toBe("sage");
    expect(toTone("slate")).toBe("lavender");
    expect(toTone(undefined, "blue")).toBe("blue");
    expect(toneClasses("peach")).toBe(TONE_CLASSES.peach);
    expect(TONE_CLASSES.sage.bar).toBe("bg-sage-fg");
  });
});
