import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createLead, createWaitlistLead, LEAD_COUNTER_KEY, type CreateLeadInput } from "@/lib/leads";

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

describe("createWaitlistLead", () => {
  const SALES = "sales@axiomatic.example";
  const waitlist: CreateLeadInput = {
    ...contact,
    kind: "WAITLIST",
    businessName: "Rao Traders",
    productId: "payroll",
    topic: null,
    message: null,
    marketingOptIn: false,
    source: "product:payroll",
    ipPrefix: "103.21.44.x",
  };
  const notify = { salesEmail: SALES, productName: "Payroll & Attendance Software" };
  const leadEmails = () => db.outboxEmail.findMany({ where: { OR: [{ dedupeKey: { startsWith: "lead_new:WAIT-" } }, { dedupeKey: { startsWith: "lead_received:WAIT-" } }] } });

  beforeEach(async () => {
    await db.outboxEmail.deleteMany({ where: { dedupeKey: { contains: ":WAIT-" } } });
  });

  it("numbers a sign-up WAIT-1001 from the shared counter and sends sales the notice, not the visitor", async () => {
    const { lead, created } = await db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, notify }));
    expect(created).toBe(true);
    expect(lead.id).toBe("WAIT-1001");
    expect(await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      kind: "WAITLIST",
      status: "NEW",
      productId: "payroll",
      email: "asha@example.com",
      businessName: "Rao Traders",
      source: "product:payroll",
    });
    const emails = await leadEmails();
    expect(emails.map((e) => e.templateId)).toEqual(["lead_new"]);
    expect(emails[0]).toMatchObject({ to: SALES, subject: "New launch waitlist sign-up: WAIT-1001 from Asha Rao" });
    expect(emails[0]?.text).toContain("Product: Payroll & Attendance Software");
    expect(emails[0]?.text).toContain("No reply is needed now");
    const next = await db.$transaction((tx) => createLead(tx, demo));
    expect(next.id).toBe("DEMO-1002");
  });

  it("keeps one sign-up per email and product: a repeat (any letter case) returns it, with no new lead, number or email", async () => {
    const first = await db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, notify }));
    const counter = await db.counter.findUniqueOrThrow({ where: { key: LEAD_COUNTER_KEY } });
    const again = await db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, email: "ASHA@Example.com", name: "Someone else", notify }));
    expect(again).toMatchObject({ created: false, lead: { id: first.lead.id, name: "Asha Rao" } });
    expect(await db.lead.count()).toBe(1);
    expect(await db.counter.findUniqueOrThrow({ where: { key: LEAD_COUNTER_KEY } })).toEqual(counter);
    expect(await leadEmails()).toHaveLength(1);
    // Closed or marked spam, it still counts as signed up.
    await db.lead.update({ where: { id: first.lead.id }, data: { status: "SPAM" } });
    expect((await db.$transaction((tx) => createWaitlistLead(tx, waitlist))).created).toBe(false);

    const other = await db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, productId: "clinic-opd" }));
    expect(other).toMatchObject({ created: true, lead: { id: "WAIT-1002" } });
    const demoSameEmail = await db.$transaction((tx) => createLead(tx, { ...demo, email: "asha@example.com" }));
    expect(demoSameEmail.id).toBe("DEMO-1003");
  });

  it("treats _ and % in an address as plain characters, not wildcards", async () => {
    const first = await db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, email: "asha.rao@example.com", notify }));
    const underscore = await db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, email: "asha_rao@example.com", notify }));
    const percent = await db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, email: "%@example.com", notify }));
    expect([first.created, underscore.created, percent.created]).toEqual([true, true, true]);
    expect(await db.lead.count({ where: { kind: "WAITLIST", productId: "payroll" } })).toBe(3);
    expect(await leadEmails()).toHaveLength(3);
    // Each one is still a duplicate of itself only.
    expect((await db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, email: "ASHA_RAO@example.com" }))).lead.id).toBe(underscore.lead.id);
    expect((await db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, email: "%@example.com" }))).lead.id).toBe(percent.lead.id);
  });

  it("keeps one sign-up under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => db.$transaction((tx) => createWaitlistLead(tx, waitlist))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.lead.id)).size).toBe(1);
    expect(await db.lead.count()).toBe(1);
  });

  it("is only for waitlist sign-ups with a product", async () => {
    await expect(db.$transaction((tx) => createWaitlistLead(tx, demo))).rejects.toThrow(/WAITLIST/);
    await expect(db.$transaction((tx) => createWaitlistLead(tx, { ...waitlist, productId: null }))).rejects.toThrow(/WAITLIST/);
  });
});
