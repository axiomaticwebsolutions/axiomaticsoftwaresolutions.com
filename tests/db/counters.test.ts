import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DocumentSeriesExhaustedError,
  nextCounterValue,
  nextCreditNoteNumber,
  nextInvoiceNumber,
  nextLicenseId,
  nextOrderId,
  nextTicketId,
} from "@/lib/counters";
import { fromIstParts } from "@/lib/dates";
import { db } from "@/lib/db";

// The DB test files share one schema and run one after another. These tests need an empty Counter table, so the
// table is saved first and put back afterwards: otherwise the files that run later would be handed ids (LIC-24200,
// T-3019, AX-10312) that earlier files already used, or an exhausted invoice series (AXS/26-27 at 1,000,000).
let saved: { key: string; next: number }[] = [];
beforeAll(async () => {
  saved = await db.counter.findMany();
});
afterAll(async () => {
  await db.$transaction([db.counter.deleteMany({}), db.counter.createMany({ data: saved })]);
});

beforeEach(async () => {
  await db.counter.deleteMany({});
});

const allocate = (key: string, start: number) => db.$transaction((tx) => nextCounterValue(tx, key, start));

describe("nextCounterValue", () => {
  it("hands out start, start + 1, ... for a new key", async () => {
    expect(await allocate("test:seq", 100)).toBe(100);
    expect(await allocate("test:seq", 100)).toBe(101);
    expect(await allocate("test:seq", 100)).toBe(102);
    expect(await db.counter.findUnique({ where: { key: "test:seq" } })).toEqual({ key: "test:seq", next: 103 });
  });

  it("keeps keys independent", async () => {
    expect(await allocate("test:a", 1)).toBe(1);
    expect(await allocate("test:b", 50)).toBe(50);
    expect(await allocate("test:a", 1)).toBe(2);
  });

  it("gives the number back when the transaction rolls back", async () => {
    expect(await allocate("test:rollback", 1)).toBe(1);
    await expect(
      db.$transaction(async (tx) => {
        expect(await nextCounterValue(tx, "test:rollback", 1)).toBe(2);
        throw new Error("abort payment transaction");
      }),
    ).rejects.toThrow("abort payment transaction");
    expect(await allocate("test:rollback", 1)).toBe(2);
  });

  it("is gap-free and unique under concurrent transactions", async () => {
    const values = await Promise.all(Array.from({ length: 8 }, () => allocate("test:concurrent", 1)));
    expect([...values].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("id helpers", () => {
  it("formats order, license and ticket ids from their configured starts", async () => {
    const ids = await db.$transaction(async (tx) => [
      await nextOrderId(tx),
      await nextOrderId(tx),
      await nextLicenseId(tx),
      await nextTicketId(tx),
    ]);
    expect(ids).toEqual(["AX-10312", "AX-10313", "LIC-24200", "T-3019"]);
  });

  it("continues from a seeded counter", async () => {
    await db.counter.create({ data: { key: "order", next: 10400 } });
    expect(await db.$transaction((tx) => nextOrderId(tx))).toBe("AX-10400");
  });
});

describe("invoice and credit note numbers", () => {
  const lastMomentFy2627 = fromIstParts({ year: 2027, month: 3, day: 31, hour: 23, minute: 59, second: 59 });
  const firstMomentFy2728 = fromIstParts({ year: 2027, month: 4, day: 1, hour: 0, minute: 0, second: 0 });

  it("uses the Indian financial year of paidAt in IST (31 Mar vs 1 Apr)", async () => {
    const numbers = await db.$transaction(async (tx) => [
      await nextInvoiceNumber(tx, lastMomentFy2627),
      await nextInvoiceNumber(tx, firstMomentFy2728),
      await nextInvoiceNumber(tx, lastMomentFy2627),
    ]);
    expect(numbers).toEqual(["AXS/26-27/0001", "AXS/27-28/0001", "AXS/26-27/0002"]);
  });

  it("decides the FY in IST, not UTC", async () => {
    // 31 Mar 2027 19:00 UTC is 1 Apr 2027 00:30 IST.
    const n = await db.$transaction((tx) => nextInvoiceNumber(tx, new Date(Date.UTC(2027, 2, 31, 19, 0))));
    expect(n).toBe("AXS/27-28/0001");
  });

  it("continues the seeded sequence and honours the prefix", async () => {
    await db.counter.create({ data: { key: "invoice:26-27", next: 1181 } });
    const n = await db.$transaction((tx) => nextInvoiceNumber(tx, lastMomentFy2627, "AXT"));
    expect(n).toBe("AXT/26-27/1181");
  });

  it("keeps credit notes in their own sequence", async () => {
    const [invoice, credit] = await db.$transaction(async (tx) => [
      await nextInvoiceNumber(tx, firstMomentFy2728),
      await nextCreditNoteNumber(tx, firstMomentFy2728),
    ]);
    expect(invoice).toBe("AXS/27-28/0001");
    expect(credit).toBe("AXC/27-28/0001");
    expect(await db.counter.findUnique({ where: { key: "creditnote:27-28" } })).toEqual({ key: "creditnote:27-28", next: 2 });
  });

  it("rejects malformed prefixes and prefixes longer than 3 characters", async () => {
    await expect(db.$transaction((tx) => nextInvoiceNumber(tx, firstMomentFy2728, "AXS/26"))).rejects.toThrow(RangeError);
    await expect(db.$transaction((tx) => nextInvoiceNumber(tx, firstMomentFy2728, "AXSIN"))).rejects.toThrow(RangeError);
  });

  it("never returns more than 16 characters: the 1,000,000th AXS invoice of a year is refused and rolled back", async () => {
    await db.counter.create({ data: { key: "invoice:26-27", next: 999_999 } });
    const last = await db.$transaction((tx) => nextInvoiceNumber(tx, lastMomentFy2627));
    expect(last).toBe("AXS/26-27/999999");
    expect(last).toHaveLength(16);
    await expect(db.$transaction((tx) => nextInvoiceNumber(tx, lastMomentFy2627))).rejects.toBeInstanceOf(
      DocumentSeriesExhaustedError,
    );
    expect(await db.counter.findUnique({ where: { key: "invoice:26-27" } })).toEqual({ key: "invoice:26-27", next: 1_000_000 });
  });
});
