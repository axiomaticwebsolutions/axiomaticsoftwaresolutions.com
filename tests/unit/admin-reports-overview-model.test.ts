/**
 * The Overview read model's groupings and prototype copy (lib/admin/overview/model.ts): payment status groups, KPI
 * sub lines, chart descriptions, bar lengths, relative times, audit action wording and assignee names.
 */
import { describe, expect, it } from "vitest";
import { OrderStatus } from "@/generated/prisma/enums";
import {
  amountsNote,
  assigneeNames,
  auditActionText,
  avgOrderText,
  barPercent,
  expiringSoonText,
  LICENSE_HEALTH_ROWS,
  openTicketsText,
  PAYMENT_STATUS_GROUPS,
  paymentStatusLabel,
  relativeTime,
  revenueChartLabel,
  revenueDelta,
  rupeesWhole,
  toneOf,
  webhookLine,
} from "@/lib/admin/overview/model";

describe("groupings", () => {
  it("puts every order status in exactly one payment status group, in prototype order", () => {
    const all = PAYMENT_STATUS_GROUPS.flatMap((g) => g.statuses);
    expect([...all].sort()).toEqual(Object.values(OrderStatus).sort());
    expect(PAYMENT_STATUS_GROUPS.map((g) => g.label)).toEqual(["Paid", "Pending", "Failed", "Refunded", "Canceled"]);
  });

  it("lists license health rows in prototype order with the 60-day expiring label", () => {
    expect(LICENSE_HEALTH_ROWS.map((r) => r.label)).toEqual(["Active", "Expiring < 60d", "Trial", "Expired", "Suspended", "Revoked"]);
  });
});

describe("copy", () => {
  it("formats whole rupees like the prototype's m0()", () => {
    expect(rupeesWhole(40_370_600)).toBe("\u20B94,03,706");
    expect(rupeesWhole(12_345)).toBe("\u20B9123");
    expect(rupeesWhole(0)).toBe("\u20B90");
  });

  it("KPI sub lines", () => {
    expect(revenueDelta(12, "30d")).toEqual({ direction: "up", text: "12% vs previous 30 days" });
    expect(revenueDelta(-5, "12m")).toEqual({ direction: "down", text: "5% vs previous 12 months" });
    expect(revenueDelta(0, "7d")).toEqual({ direction: "up", text: "0% vs previous 7 days" });
    expect(revenueDelta(null, "90d")).toEqual({ direction: null, text: "No revenue in the previous 90 days" });
    expect(avgOrderText(568_600)).toBe("Avg \u20B95,686 per order");
    expect(expiringSoonText(1)).toBe("1 expires in the next 30 days");
    expect(expiringSoonText(6)).toBe("6 expire in the next 30 days");
    expect(openTicketsText(4, 3)).toBe("4 high priority \u00B7 3 unassigned");
  });

  it("toolbar note, chart and payment descriptions, webhook line", () => {
    expect(amountsNote(true)).toBe("Sample data \u00B7 amounts exclude GST unless noted");
    expect(amountsNote(false)).toBe("Amounts exclude GST unless noted");
    expect(revenueChartLabel("30d", 7_308_900, 2_500_000, "day")).toBe("Revenue over the last 30 days, total \u20B973,089. Peak \u20B925,000 per day.");
    expect(revenueChartLabel("12m", 0, 0, "month")).toBe("Revenue over the last 12 months, total \u20B90. Peak \u20B90 per month.");
    expect(paymentStatusLabel([])).toBe("No orders in this period.");
    expect(paymentStatusLabel([{ label: "Paid", count: 10 }, { label: "Pending", count: 1 }])).toBe("Paid 10, Pending 1");
    expect(webhookLine({ fulfilled: 1, duplicates: 1, rejected: 1 })).toBe("Webhooks: 1 fulfilled \u00B7 1 duplicates ignored \u00B7 1 rejected (bad signature)");
  });
});

describe("helpers", () => {
  it("barPercent: share of the maximum with a floor for non-zero values", () => {
    expect(barPercent(0, 100, 3)).toBe(0);
    expect(barPercent(1, 100, 3)).toBe(3);
    expect(barPercent(50, 100)).toBe(50);
    expect(barPercent(200, 100)).toBe(100);
    expect(barPercent(5, 0)).toBe(0);
  });

  it("relativeTime like the prototype's rel()", () => {
    const now = new Date("2026-10-07T04:30:00.000Z");
    const ago = (ms: number) => relativeTime(new Date(now.getTime() - ms), now);
    expect(ago(30_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(4 * 86_400_000)).toBe("4d ago");
    expect(ago(40 * 86_400_000)).toBe("28 Aug 2026");
  });

  it("auditActionText lowers the first letter and shows older webhook machine names under their label", () => {
    expect(auditActionText("Issued refund")).toBe("issued refund");
    expect(auditActionText("Deactivated device Counter PC")).toBe("deactivated device Counter PC");
    expect(auditActionText("order.paid")).toBe("webhook processed");
    expect(auditActionText("payment.captured_twice")).toBe("duplicate payment captured");
    expect(auditActionText("Webhook processed")).toBe("webhook processed");
    expect(auditActionText("some.other_event")).toBe("some other event");
  });

  it("assigneeNames uses first names unless two people share one", () => {
    const names = assigneeNames([
      { id: "1", name: "Sneha Patil" },
      { id: "2", name: "Sneha Rao" },
      { id: "3", name: "Vikram Rao" },
      { id: "4", name: "  Rahul  " },
    ]);
    expect([...names.entries()]).toEqual([["1", "Sneha Patil"], ["2", "Sneha Rao"], ["3", "Vikram"], ["4", "Rahul"]]);
  });

  it("toneOf accepts known tones only", () => {
    expect(toneOf("sage")).toBe("sage");
    expect(toneOf("purple")).toBe("lavender");
    expect(toneOf(null, "blue")).toBe("blue");
  });
});
