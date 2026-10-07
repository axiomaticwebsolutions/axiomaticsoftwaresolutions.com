import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  addCalendarMonths,
  addCalendarYears,
  addDays,
  daysUntil,
  endOfDayIST,
  fiscalYearLabel,
  formatDateIST,
  formatDateTimeIST,
  formatMonthYearIST,
  fromIstParts,
  istCalendarYear,
  istParts,
  maxDate,
  startOfDayIST,
} from "@/lib/dates";

const ist = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  fromIstParts({ year, month, day, hour, minute });

describe("fiscalYearLabel", () => {
  it("switches at midnight IST on 1 April", () => {
    expect(fiscalYearLabel(new Date("2026-03-31T18:29:59.999Z"))).toBe("25-26");
    expect(fiscalYearLabel(new Date("2026-03-31T18:30:00Z"))).toBe("26-27");
  });

  it("labels the rest of the year", () => {
    expect(fiscalYearLabel(new Date("2026-10-06T06:00:00Z"))).toBe("26-27");
    expect(fiscalYearLabel(new Date("2027-01-15T06:00:00Z"))).toBe("26-27");
    expect(fiscalYearLabel(new Date("2099-06-01T00:00:00Z"))).toBe("99-00");
  });
});

describe("formatting in IST", () => {
  it("formats dates with fixed English month abbreviations", () => {
    expect(formatDateIST(new Date("2026-09-15T00:00:00Z"))).toBe("15 Sep 2026");
    expect(formatDateIST(null)).toBe("\u2014");
    expect(formatDateIST(undefined, "never")).toBe("never");
  });

  it("rolls over to the next day after 18:30 UTC", () => {
    const d = new Date("2026-09-15T19:00:00Z");
    expect(formatDateIST(d)).toBe("16 Sep 2026");
    expect(istParts(d)).toMatchObject({ year: 2026, month: 9, day: 16, hour: 0, minute: 30 });
    expect(formatDateIST(new Date("2026-09-15T18:29:59.999Z"))).toBe("15 Sep 2026");
  });

  it("formats date-times and month-years", () => {
    expect(formatDateTimeIST(new Date("2026-09-15T08:35:00Z"))).toBe("15 Sep 2026, 14:05");
    expect(formatMonthYearIST(new Date("2026-08-31T19:00:00Z"))).toBe("Sep 2026");
  });

  it("round-trips IST parts", () => {
    const d = ist(2026, 10, 6, 9, 15);
    expect(d.toISOString()).toBe("2026-10-06T03:45:00.000Z");
    expect(istParts(d)).toMatchObject({ year: 2026, month: 10, day: 6, hour: 9, minute: 15 });
  });
});

describe("calendar arithmetic", () => {
  it("clamps to the end of shorter months", () => {
    expect(formatDateIST(addCalendarMonths(ist(2027, 1, 31), 1))).toBe("28 Feb 2027");
    expect(formatDateIST(addCalendarMonths(ist(2028, 1, 31), 1))).toBe("29 Feb 2028");
    expect(formatDateIST(addCalendarMonths(ist(2026, 8, 31), 1))).toBe("30 Sep 2026");
  });

  it("keeps the IST time of day", () => {
    const d = addCalendarMonths(ist(2027, 1, 31, 23, 45), 1);
    expect(istParts(d)).toMatchObject({ year: 2027, month: 2, day: 28, hour: 23, minute: 45 });
  });

  it("supports negative months and year boundaries", () => {
    expect(formatDateIST(addCalendarMonths(ist(2026, 3, 31), -1))).toBe("28 Feb 2026");
    expect(formatDateIST(addCalendarMonths(ist(2027, 1, 15), -1))).toBe("15 Dec 2026");
    expect(formatDateIST(addCalendarMonths(ist(2026, 11, 30), 3))).toBe("28 Feb 2027");
    expect(formatDateIST(addCalendarMonths(ist(2026, 10, 6), 12))).toBe("6 Oct 2027");
  });

  it("adds calendar years, clamping 29 Feb", () => {
    expect(formatDateIST(addCalendarYears(ist(2028, 2, 29), 1))).toBe("28 Feb 2029");
    expect(formatDateIST(addCalendarYears(ist(2026, 10, 6), 1))).toBe("6 Oct 2027");
  });

  it("works on the IST date, not the UTC date", () => {
    // 31 Jan 2027 00:30 IST is still 30 Jan in UTC.
    const d = new Date("2027-01-30T19:00:00Z");
    expect(formatDateIST(addCalendarMonths(d, 1))).toBe("28 Feb 2027");
  });

  it("adds whole days", () => {
    const d = new Date("2026-10-06T00:00:00Z");
    expect(addDays(d, 365).toISOString()).toBe("2027-10-06T00:00:00.000Z");
    expect(addDays(d, -1).getTime()).toBe(d.getTime() - DAY_MS);
  });
});

describe("IST day boundaries", () => {
  it("returns the start and end of an IST calendar day", () => {
    expect(startOfDayIST("2026-08-31").toISOString()).toBe("2026-08-30T18:30:00.000Z");
    expect(endOfDayIST("2026-08-31").toISOString()).toBe("2026-08-31T18:29:59.999Z");
    expect(startOfDayIST(new Date("2026-09-15T19:00:00Z")).toISOString()).toBe("2026-09-15T18:30:00.000Z");
    expect(formatDateIST(endOfDayIST("2026-08-31"))).toBe("31 Aug 2026");
  });

  it("rejects malformed date strings", () => {
    expect(() => startOfDayIST("31/08/2026")).toThrow(RangeError);
    expect(() => endOfDayIST("2026-8-31")).toThrow(RangeError);
  });
});

describe("istCalendarYear", () => {
  it("switches at midnight IST on 1 January", () => {
    expect(istCalendarYear(new Date("2026-12-31T18:29:59.999Z"))).toBe(2026);
    expect(istCalendarYear(new Date("2026-12-31T18:30:00Z"))).toBe(2027);
  });
});

describe("maxDate", () => {
  it("returns the later date and handles null", () => {
    const a = new Date("2026-01-01T00:00:00Z");
    const b = new Date("2026-06-01T00:00:00Z");
    expect(maxDate(a, b)).toBe(b);
    expect(maxDate(b, a)).toBe(b);
    expect(maxDate(null, a)).toBe(a);
    expect(maxDate(undefined, a)).toBe(a);
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-10-06T06:00:00Z");

  it("rounds partial days up", () => {
    expect(daysUntil(new Date(now.getTime() + 1), now)).toBe(1);
    expect(daysUntil(new Date(now.getTime() + DAY_MS), now)).toBe(1);
    expect(daysUntil(new Date(now.getTime() + DAY_MS + 1), now)).toBe(2);
    expect(daysUntil(addDays(now, 60), now)).toBe(60);
  });

  it("is 0 when due now or already past", () => {
    expect(daysUntil(now, now)).toBe(0);
    expect(daysUntil(addDays(now, -5), now)).toBe(0);
  });
});
