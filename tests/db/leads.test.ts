import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createLead, LEAD_COUNTER_KEY, type CreateLeadInput } from "@/lib/leads";

const demo: CreateLeadInput = {
  kind: "DEMO",
  name: "Asha Rao",
  businessName: "Rao Medicals",
  email: "asha@example.com",
  phone: "9820000000",
  productId: "medical-billing",
  countersBand: "2-3",
  preferredDate: "2026-10-08",
  preferredSlot: "afternoon",
  topic: null,
  message: null,
  marketingOptIn: false,
  source: "product:medical-billing",
  ipPrefix: "103.21.44.x",
};

const contact: CreateLeadInput = {
  ...demo,
  kind: "CONTACT",
  businessName: null,
  phone: null,
  productId: null,
  countersBand: null,
  preferredDate: null,
  preferredSlot: null,
  topic: "licensing",
  message: "How do licenses move between computers?",
  marketingOptIn: true,
  source: null,
  ipPrefix: null,
};

beforeEach(async () => {
  await db.lead.deleteMany({});
  await db.counter.deleteMany({ where: { key: LEAD_COUNTER_KEY } });
});

describe("createLead", () => {
  it("allocates DEMO-/MSG- references from one shared counter starting at 1001", async () => {
    const a = await db.$transaction((tx) => createLead(tx, demo));
    const b = await db.$transaction((tx) => createLead(tx, contact));
    const c = await db.$transaction((tx) => createLead(tx, demo));
    expect([a.id, b.id, c.id]).toEqual(["DEMO-1001", "MSG-1002", "DEMO-1003"]);
    expect(await db.counter.findUnique({ where: { key: LEAD_COUNTER_KEY } })).toEqual({ key: LEAD_COUNTER_KEY, next: 1004 });
  });

  it("stores every field with status NEW", async () => {
    const created = await db.$transaction((tx) => createLead(tx, demo));
    const row = await db.lead.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({
      kind: "DEMO",
      status: "NEW",
      name: "Asha Rao",
      businessName: "Rao Medicals",
      email: "asha@example.com",
      phone: "9820000000",
      productId: "medical-billing",
      countersBand: "2-3",
      preferredDate: "2026-10-08",
      preferredSlot: "afternoon",
      topic: null,
      message: null,
      marketingOptIn: false,
      source: "product:medical-billing",
      ipPrefix: "103.21.44.x",
    });
    const msg = await db.$transaction((tx) => createLead(tx, contact));
    expect(await db.lead.findUniqueOrThrow({ where: { id: msg.id } })).toMatchObject({
      kind: "CONTACT",
      topic: "licensing",
      message: "How do licenses move between computers?",
      marketingOptIn: true,
      ipPrefix: null,
    });
  });

  it("gives the number back when the transaction rolls back", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await createLead(tx, demo);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.lead.count()).toBe(0);
    const next = await db.$transaction((tx) => createLead(tx, contact));
    expect(next.id).toBe("MSG-1001");
  });

  it("hands out unique references under concurrency", async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => db.$transaction((tx) => createLead(tx, demo))));
    expect(new Set(ids.map((l) => l.id)).size).toBe(6);
    expect(ids.map((l) => Number(l.id.slice(5))).sort((x, y) => x - y)).toEqual([1001, 1002, 1003, 1004, 1005, 1006]);
  });
});
