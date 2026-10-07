import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  dispatchPendingEmails,
  enqueueEmail,
  kickEmailDispatch,
  outboxBackoffMs,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  setEmailAutoDispatch,
  setEmailTransport,
  waitForEmailDispatch,
  EmailTemplateError,
  type EmailTransport,
  type OutgoingEmail,
} from "@/lib/email";
import { countStoredInviteLinks, redactStoredInviteLinks, REDACTED_INVITE_ERROR } from "@/lib/email/redact";
import { createLead, LEAD_COUNTER_KEY, type CreateLeadInput } from "@/lib/leads";
import { setLogSink } from "@/lib/log";

const ORDER_VARS = {
  customer_name: "Priya <Sharma>",
  order_id: "AX-10312",
  order_url: "http://localhost:3000/orders/AX-10312?t=abc",
  total: "₹5,898.82",
  invoice_number: "AXS/26-27/1181",
};

type FakeTransport = EmailTransport & { sent: OutgoingEmail[]; failWith: Error | null; delayMs: number };

function fakeTransport(): FakeTransport {
  const t: FakeTransport = {
    name: "test",
    sent: [],
    failWith: null,
    delayMs: 0,
    async send(message) {
      if (t.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, t.delayMs));
      if (t.failWith) throw t.failWith;
      t.sent.push(message);
      return { messageId: `m-${t.sent.length}` };
    },
  };
  return t;
}

let transport: FakeTransport;
let logs: string[];

async function enqueueOrder(id: string, extra: Partial<Parameters<typeof enqueueEmail>[1]> = {}) {
  await db.$transaction((tx) =>
    enqueueEmail(tx, {
      to: "priya@sharmamedicals.example",
      templateId: "order_confirmation",
      vars: { ...ORDER_VARS, order_id: id },
      dedupeKey: `order_confirmation:${id}`,
      ...extra,
    }),
  );
}

beforeEach(async () => {
  await db.outboxEmail.deleteMany({});
  await db.notificationTemplate.deleteMany({});
  transport = fakeTransport();
  setEmailTransport(transport);
  logs = [];
  setLogSink((_level, line) => logs.push(line));
});

afterEach(() => {
  setLogSink(null);
  setEmailAutoDispatch(null);
});

afterAll(() => setEmailTransport(null));

describe("enqueueEmail", () => {
  it("renders the email and stores a PENDING row in the caller's transaction", async () => {
    const before = Date.now();
    await enqueueOrder("AX-10312");
    const row = await db.outboxEmail.findFirstOrThrow();
    expect(row).toMatchObject({
      templateId: "order_confirmation",
      to: "priya@sharmamedicals.example",
      subject: "Your order AX-10312 is confirmed",
      status: "PENDING",
      attempts: 0,
      dedupeKey: "order_confirmation:AX-10312",
      sentAt: null,
      lastError: null,
    });
    expect(row.sendAfter.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.html).toContain("Hi Priya &lt;Sharma&gt;,");
    expect(row.html).toContain('href="http://localhost:3000/orders/AX-10312?t=abc"');
    expect(row.html).toContain("AXS/26-27/1181");
    expect(row.text).toContain("Total paid: ₹5,898.82");
  });

  it("ignores a duplicate dedupe key without aborting the transaction", async () => {
    await enqueueOrder("AX-1");
    await db.$transaction(async (tx) => {
      await enqueueEmail(tx, { to: "x@example.com", templateId: "order_confirmation", vars: ORDER_VARS, dedupeKey: "order_confirmation:AX-1" });
      await enqueueEmail(tx, { to: "x@example.com", templateId: "order_confirmation", vars: ORDER_VARS, dedupeKey: "order_confirmation:AX-1" });
      // The transaction is still usable after the ignored inserts.
      await tx.outboxEmail.count();
    });
    const rows = await db.outboxEmail.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.to).toBe("priya@sharmamedicals.example");
    // Without a key every enqueue is stored.
    await db.$transaction(async (tx) => {
      await enqueueEmail(tx, { to: "x@example.com", templateId: "payment_failed", vars: ORDER_VARS });
      await enqueueEmail(tx, { to: "x@example.com", templateId: "payment_failed", vars: ORDER_VARS });
    });
    expect(await db.outboxEmail.count()).toBe(3);
  });

  it("stores nothing when the transaction rolls back", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await enqueueEmail(tx, { to: "x@example.com", templateId: "order_confirmation", vars: ORDER_VARS, dedupeKey: "k1" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.outboxEmail.count()).toBe(0);
  });

  it("refuses auth and invitation templates, unknown templates, bad recipients and missing variables (outside production)", async () => {
    const invite = { inviter_name: "A", account_name: "B", role_label: "Viewer", invite_url: "http://localhost:3000/invite?token=x.y", expires: "1 Jan" };
    const cases: Array<[Parameters<typeof enqueueEmail>[1], string]> = [
      [{ to: "a@example.com", templateId: "email_verification", vars: { customer_name: "A", code: "123456" } }, "auth_template"],
      // Invitation links are bearer credentials: sent directly, never stored.
      [{ to: "a@example.com", templateId: "team_invite", vars: invite }, "auth_template"],
      [{ to: "a@example.com", templateId: "staff_invite", vars: invite }, "auth_template"],
      [{ to: "a@example.com", templateId: "no_such_template", vars: {} }, "unknown_template"],
      [{ to: "a@example.com, b@example.com", templateId: "order_confirmation", vars: ORDER_VARS }, "invalid_recipient"],
      [{ to: "a@example.com", templateId: "order_confirmation", vars: { customer_name: "A", order_id: "AX-1" } }, "missing_vars"],
    ];
    for (const [input, reason] of cases) {
      const error = await db.$transaction((tx) => enqueueEmail(tx, input)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmailTemplateError);
      expect((error as EmailTemplateError).reason).toBe(reason);
    }
    expect(await db.outboxEmail.count()).toBe(0);
  });

  it("uses an active NotificationTemplate row for the copy, the defaults while it is a draft", async () => {
    await db.notificationTemplate.create({
      data: { id: "order_confirmation", name: "Order confirmation", subject: "Paid: {{order_id}}", body: "Hello {{customer_name}}!", active: true },
    });
    await enqueueOrder("AX-2");
    await db.notificationTemplate.update({ where: { id: "order_confirmation" }, data: { active: false } });
    await enqueueOrder("AX-3");
    const byKey = async (key: string) => db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey: key } });
    expect((await byKey("order_confirmation:AX-2")).subject).toBe("Paid: AX-2");
    expect((await byKey("order_confirmation:AX-3")).subject).toBe("Your order AX-3 is confirmed");
    expect((await byKey("order_confirmation:AX-2")).html).toContain("Hello Priya &lt;Sharma&gt;!");
    expect((await byKey("order_confirmation:AX-2")).html).toContain("View your order"); // blocks stay code-defined
  });
});

describe("dispatchPendingEmails", () => {
  it("sends due rows, marks them SENT and leaves future rows alone", async () => {
    await enqueueOrder("AX-1");
    await enqueueOrder("AX-2", { sendAfter: new Date(Date.now() + 3_600_000) });
    const now = new Date(Date.now() + 1000);
    expect(await dispatchPendingEmails({ now })).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent.map((m) => m.subject)).toEqual(["Your order AX-1 is confirmed"]);
    expect(transport.sent[0]?.html).toContain("<!DOCTYPE html>");
    const sent = await db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey: "order_confirmation:AX-1" } });
    expect(sent).toMatchObject({ status: "SENT", attempts: 1, lastError: null });
    expect(sent.sentAt).not.toBeNull();
    const later = await db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey: "order_confirmation:AX-2" } });
    expect(later).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(await dispatchPendingEmails({ now })).toEqual({ sent: 0, failed: 0 });
    // Logs carry ids and masked addresses, never subjects, bodies or links.
    const out = logs.join("\n");
    expect(out).toContain("email_sent");
    expect(out).not.toMatch(/priya@|Your order|t=abc/);
  });

  it("retries with exponential backoff and gives up after the last attempt", async () => {
    await enqueueOrder("AX-9");
    transport.failWith = Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
    let now = new Date(Date.now() + 1000);
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      expect(await dispatchPendingEmails({ now })).toEqual({ sent: 0, failed: 1 });
      const row = await db.outboxEmail.findFirstOrThrow();
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toContain("ECONNREFUSED");
      if (attempt < OUTBOX_MAX_ATTEMPTS) {
        expect(row.status).toBe("PENDING");
        expect(row.sendAfter.getTime()).toBe(now.getTime() + outboxBackoffMs(attempt));
        // Not due yet: nothing is claimed.
        expect(await dispatchPendingEmails({ now: new Date(row.sendAfter.getTime() - 1) })).toEqual({ sent: 0, failed: 0 });
        now = row.sendAfter;
      } else {
        expect(row.status).toBe("FAILED");
      }
    }
    transport.failWith = null;
    expect(await dispatchPendingEmails({ now: new Date(now.getTime() + 86_400_000) })).toEqual({ sent: 0, failed: 0 });
    expect(transport.sent).toHaveLength(0);
  });

  it("never hands the same row to two concurrent dispatchers", async () => {
    const total = 40;
    await db.outboxEmail.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        templateId: "order_confirmation",
        to: `c${i}@example.com`,
        subject: `S${i}`,
        html: "<p>h</p>",
        text: "t",
        dedupeKey: `bulk:${i}`,
        sendAfter: new Date(Date.now() - 1000),
      })),
    });
    transport.delayMs = 3;
    const now = new Date();
    const runs = await Promise.all([
      dispatchPendingEmails({ now, limit: 15 }),
      dispatchPendingEmails({ now, limit: 15 }),
      dispatchPendingEmails({ now, limit: 15 }),
    ]);
    const claimed = runs.reduce((n, r) => n + r.sent, 0);
    expect(claimed).toBe(transport.sent.length);
    const subjects = transport.sent.map((m) => m.subject);
    expect(new Set(subjects).size).toBe(subjects.length);
    // Drain the rest and check every row went out exactly once.
    while ((await dispatchPendingEmails({ now, limit: 15 })).sent > 0);
    expect(transport.sent).toHaveLength(total);
    expect(new Set(transport.sent.map((m) => m.subject)).size).toBe(total);
    expect(await db.outboxEmail.count({ where: { status: "SENT", attempts: 1 } })).toBe(total);
  });

  it("re-sends rows whose dispatcher died mid-send once the lease expires", async () => {
    const now = new Date();
    const base = { templateId: "lead_received", html: "<p>h</p>", text: "t", status: "SENDING" as const };
    await db.outboxEmail.createMany({
      data: [
        { ...base, to: "a@example.com", subject: "fresh lease", attempts: 1, sendAfter: new Date(now.getTime() + OUTBOX_LEASE_MS - 1000) },
        { ...base, to: "b@example.com", subject: "expired lease", attempts: 1, sendAfter: new Date(now.getTime() - 1000) },
        { ...base, to: "c@example.com", subject: "exhausted", attempts: OUTBOX_MAX_ATTEMPTS, sendAfter: new Date(now.getTime() - 1000) },
      ],
    });
    expect(await dispatchPendingEmails({ now })).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent.map((m) => m.subject)).toEqual(["expired lease"]);
    const rows = Object.fromEntries((await db.outboxEmail.findMany()).map((r) => [r.subject, r]));
    expect(rows["fresh lease"]?.status).toBe("SENDING");
    expect(rows["expired lease"]).toMatchObject({ status: "SENT", attempts: 2 });
    expect(rows.exhausted?.status).toBe("FAILED");
  });

  it("kicks one coalesced dispatch after commit", async () => {
    setEmailAutoDispatch(true);
    await enqueueOrder("AX-21");
    await enqueueOrder("AX-22");
    for (let i = 0; i < 5; i += 1) kickEmailDispatch();
    await waitForEmailDispatch();
    expect(transport.sent.map((m) => m.subject).sort()).toEqual(["Your order AX-21 is confirmed", "Your order AX-22 is confirmed"]);
    // A kick while a run is in progress triggers one follow-up run that picks up the new row.
    transport.delayMs = 20;
    await enqueueOrder("AX-23");
    kickEmailDispatch();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await enqueueOrder("AX-24");
    kickEmailDispatch();
    await waitForEmailDispatch();
    expect(transport.sent).toHaveLength(4);
    expect(await db.outboxEmail.count({ where: { status: "SENT" } })).toBe(4);
  });
});

describe("lead emails", () => {
  const demo: CreateLeadInput = {
    kind: "DEMO",
    name: "Asha Rao",
    businessName: "Rao & Sons <Medicals>",
    email: "asha@example.com",
    phone: "9820000000",
    productId: "medical-billing",
    countersBand: "2-3",
    preferredDate: "2026-10-08",
    preferredSlot: "afternoon",
    topic: null,
    message: "Two counters.\n<script>x</script> https://spam.example",
    marketingOptIn: false,
    source: "product:medical-billing",
    ipPrefix: "103.21.44.x",
  };

  beforeEach(async () => {
    await db.lead.deleteMany({});
    await db.counter.deleteMany({ where: { key: LEAD_COUNTER_KEY } });
  });

  it("enqueues the acknowledgement and the sales notice in the lead transaction", async () => {
    const lead = await db.$transaction((tx) =>
      createLead(tx, { ...demo, notify: { salesEmail: "sales@axiomatic.example", productName: "Medical Billing" } }),
    );
    const ack = await db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey: `lead_received:${lead.id}` } });
    expect(ack).toMatchObject({ to: "asha@example.com", templateId: "lead_received", subject: `We received your demo request (${lead.id})` });
    expect(ack.text).toContain("Hi Asha Rao,");
    expect(ack.text).not.toContain("Two counters"); // the visitor's message is never echoed to them

    const notice = await db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey: `lead_new:${lead.id}` } });
    expect(notice).toMatchObject({ to: "sales@axiomatic.example", templateId: "lead_new", subject: `New demo request: ${lead.id} from Asha Rao` });
    expect(notice.html).toContain("Rao &amp; Sons &lt;Medicals&gt;");
    expect(notice.html).toContain("Two counters.<br>&lt;script&gt;x&lt;/script&gt; https://spam.example");
    expect(notice.html).not.toContain('href="https://spam.example"');
    expect(notice.text).toContain("Preferred time: 8 Oct 2026, Afternoon (2–5)");
    expect(notice.text).toContain("Phone: +91 98200 00000");
    expect(notice.text).toContain("Product: Medical Billing");
  });

  it("enqueues nothing without notify, and nothing survives a rolled-back lead", async () => {
    await db.$transaction((tx) => createLead(tx, demo));
    expect(await db.outboxEmail.count()).toBe(0);
    await expect(
      db.$transaction(async (tx) => {
        await createLead(tx, { ...demo, notify: { salesEmail: "sales@axiomatic.example", productName: null } });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.outboxEmail.count()).toBe(0);
  });
});

describe("redactStoredInviteLinks (invitation emails stored by older versions)", () => {
  it("removes the link tokens, fails unsent rows and leaves other templates alone; idempotent", async () => {
    const link = (path: string) => `http://localhost:3000${path}?token=ckabc123.Zx-_9secretSECRET`;
    const row = (templateId: string, status: "PENDING" | "SENT", path: string) =>
      db.outboxEmail.create({
        data: { templateId, to: `${templateId}@example.com`, subject: "S", status, html: `<a href="${link(path)}">Accept</a>`, text: `Open ${link(path)} now` },
      });
    const staff = await row("staff_invite", "PENDING", "/staff-invite");
    const team = await row("team_invite", "SENT", "/invite");
    const order = await row("order_confirmation", "PENDING", "/orders/AX-1");
    expect(await countStoredInviteLinks(db)).toBe(2);
    expect(await redactStoredInviteLinks(db)).toBe(2);
    const after = await db.outboxEmail.findMany({ where: { id: { in: [staff.id, team.id, order.id] } } });
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(staff.id)).toMatchObject({
      status: "FAILED",
      lastError: REDACTED_INVITE_ERROR,
      html: '<a href="http://localhost:3000/staff-invite?token=removed">Accept</a>',
      text: "Open http://localhost:3000/staff-invite?token=removed now",
    });
    expect(byId.get(team.id)).toMatchObject({ status: "SENT", lastError: null, text: "Open http://localhost:3000/invite?token=removed now" });
    expect(byId.get(order.id)).toMatchObject({ status: "PENDING", text: `Open ${link("/orders/AX-1")} now` });
    expect(after.filter((r) => r.templateId !== "order_confirmation").some((r) => r.html.includes("secret") || r.text.includes("secret"))).toBe(false);
    expect(await countStoredInviteLinks(db)).toBe(0);
    expect(await redactStoredInviteLinks(db)).toBe(0);
  });
});

describe("GET|POST /api/cron/emails", () => {
  async function call(method: "GET" | "POST", authorization?: string) {
    const { GET, POST } = await import("@/app/api/cron/emails/route");
    const headers: Record<string, string> = authorization ? { authorization } : {};
    const req = new NextRequest("http://localhost:3000/api/cron/emails", { method, headers });
    const res = await (method === "GET" ? GET : POST)(req, undefined);
    return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, unknown> };
  }

  it("requires the cron bearer token", async () => {
    await enqueueOrder("AX-31");
    for (const auth of [undefined, "Bearer wrong-secret", `Basic ${process.env.CRON_SECRET}`, `Bearer ${process.env.CRON_SECRET}x`]) {
      const res = await call("POST", auth);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: { code: "unauthorized", message: "Missing or invalid cron credentials." } });
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="cron"');
    }
    expect(transport.sent).toHaveLength(0);
  });

  it("dispatches due emails and reports the counts", async () => {
    await enqueueOrder("AX-32");
    await enqueueOrder("AX-33");
    const res = await call("GET", `Bearer ${process.env.CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ sent: 2, failed: 0 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await call("POST", `bearer ${process.env.CRON_SECRET}`)).json).toEqual({ sent: 0, failed: 0 });
  });
});
