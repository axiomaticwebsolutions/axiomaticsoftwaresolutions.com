/**
 * Date ranges of the admin Overview and Reports (lib/admin/overview/range.ts): 7d / 30d / 90d / 12m in IST, the
 * previous period, chart buckets (days, 13 weeks, 12 months), ticks, descriptions and the percentage change.
 */
import { describe, expect, it } from "vitest";
import {
  bucketIndex,
  deltaPercent,
  istDayKey,
  monthKeysInWindow,
  parseRange,
  rangeDescription,
  rangeTicks,
  rangeWindow,
  windowMonthLabel,
} from "@/lib/admin/overview/range";

/** 7 Oct 2026, 10:00 IST. */
const NOW = new Date("2026-10-07T04:30:00.000Z");
const ist = (s: string) => new Date(`${s}T00:00:00.000+05:30`);

describe("parseRange", () => {
  it("accepts the four ranges and falls back to 30 days", () => {
    expect(["7d", "30d", "90d", "12m"].map(parseRange)).toEqual(["7d", "30d", "90d", "12m"]);
    expect(parseRange("5y")).toBe("30d");
    expect(parseRange(undefined)).toBe("30d");
    expect(parseRange(["90d", "7d"])).toBe("90d");
    expect(parseRange(30)).toBe("30d");
  });
});

describe("rangeWindow", () => {
  it("30 days: the last 30 IST days including today, one bucket per day", () => {
    const w = rangeWindow("30d", NOW);
    expect(w.from).toEqual(ist("2026-09-08"));
    expect(w.to).toEqual(NOW);
    expect(w.prevFrom).toEqual(ist("2026-08-09"));
    expect(w.prevTo).toEqual(new Date(NOW.getTime() - 30 * 86_400_000));
    expect(w.unit).toBe("day");
    expect(w.buckets).toHaveLength(30);
    expect(w.buckets[0]).toMatchObject({ key: "2026-09-08", label: "8 Sep", title: "8 Sep 2026" });
    expect(w.buckets.at(-1)).toMatchObject({ key: "2026-10-07", label: "7 Oct" });
  });

  it("7 days starts on 1 Oct", () => {
    const w = rangeWindow("7d", NOW);
    expect(w.from).toEqual(ist("2026-10-01"));
    expect(w.buckets.map((b) => b.key)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("90 days: 13 contiguous weekly buckets ending tonight, the first one shorter", () => {
    const w = rangeWindow("90d", NOW);
    expect(w.from).toEqual(ist("2026-07-10"));
    expect(w.unit).toBe("week");
    expect(w.buckets).toHaveLength(13);
    expect(w.buckets[0]?.start).toEqual(w.from);
    expect(w.buckets[0]?.end).toEqual(ist("2026-07-16"));
    expect(w.buckets.at(-1)?.end).toEqual(ist("2026-10-08"));
    expect(w.buckets.at(-1)?.title).toBe("Week of 1 Oct 2026");
    for (let i = 1; i < w.buckets.length; i++) expect(w.buckets[i]?.start).toEqual(w.buckets[i - 1]?.end);
  });

  it("12 months: this IST month and the 11 before it; the previous period is a year earlier", () => {
    const w = rangeWindow("12m", NOW);
    expect(w.from).toEqual(ist("2025-11-01"));
    expect(w.prevFrom).toEqual(ist("2024-11-01"));
    expect(w.prevTo).toEqual(new Date("2025-10-07T04:30:00.000Z"));
    expect(w.unit).toBe("month");
    expect(w.buckets.map((b) => b.key)).toEqual([
      "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
    ]);
    expect(w.buckets[0]).toMatchObject({ label: "Nov", title: "Nov 2025" });
    expect(w.buckets[3]?.end).toEqual(ist("2026-03-01"));
  });
});

describe("helpers", () => {
  it("bucketIndex places a time in its bucket, -1 outside", () => {
    const w = rangeWindow("30d", NOW);
    expect(bucketIndex(w.buckets, w.from)).toBe(0);
    expect(bucketIndex(w.buckets, new Date(w.from.getTime() - 1))).toBe(-1);
    expect(bucketIndex(w.buckets, NOW)).toBe(29);
    expect(bucketIndex(w.buckets, ist("2026-09-20"))).toBe(12);
  });

  it("IST day keys, month keys of a window, ticks and descriptions", () => {
    expect(istDayKey(new Date("2026-10-06T19:00:00.000Z"))).toBe("2026-10-07");
    expect(monthKeysInWindow(rangeWindow("30d", NOW))).toEqual(["2026-09", "2026-10"]);
    expect(monthKeysInWindow(rangeWindow("7d", NOW))).toEqual(["2026-10"]);
    expect(rangeTicks(rangeWindow("30d", NOW).buckets)).toEqual(["8 Sep", "18 Sep", "28 Sep", "Today"]);
    expect(rangeTicks([])).toEqual([]);
    expect(rangeDescription(rangeWindow("30d", NOW))).toBe("Last 30 days (8 Sep \u2013 7 Oct 2026)");
    expect(rangeDescription(rangeWindow("12m", NOW))).toBe("Last 12 months (1 Nov 2025 \u2013 7 Oct 2026)");
  });

  it("windowMonthLabel marks a first month that starts after the 1st", () => {
    const from = rangeWindow("30d", NOW).from;
    expect(windowMonthLabel("2026-09", from)).toBe("Sep 2026 (from 8 Sep)");
    expect(windowMonthLabel("2026-10", from)).toBe("Oct 2026");
    expect(windowMonthLabel("2026-09", null)).toBe("Sep 2026");
    expect(windowMonthLabel("2025-11", rangeWindow("12m", NOW).from)).toBe("Nov 2025");
  });

  it("deltaPercent rounds to whole percent and has nothing to compare with an empty previous period", () => {
    expect(deltaPercent(600, 250)).toBe(140);
    expect(deltaPercent(50, 100)).toBe(-50);
    expect(deltaPercent(1, 3)).toBe(-67);
    expect(deltaPercent(100, 0)).toBeNull();
    expect(deltaPercent(0, 0)).toBeNull();
  });
});
