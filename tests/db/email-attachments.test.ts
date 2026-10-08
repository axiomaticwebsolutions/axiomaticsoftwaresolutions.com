/**
 * The invoice PDF attached to the order_confirmation email (docs/decisions.md "Invoice PDF attached to the order
 * email"): payment and Admin "Resend invoice" store a typed reference on the outbox row (never bytes), the dispatcher
 * renders the order's current invoice after claiming (the document lib/invoice/document.ts gives both invoice.pdf
 * routes), and a PDF that cannot be produced never blocks the email (retried once for errors, timeouts, a busy
 * renderer or a spent run budget, else sent without it; the final attempt always goes without it; logged without
 * addresses). The renderer is wrapped so tests can make it fail, hold until released, slow down or grow.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PdfModule from "@/lib/invoice/pdf";

const pdfState = vi.hoisted(() => ({
  mode: "real" as "real" | "throw" | "held" | "delay" | "huge",
  calls: 0,
  /** "held": renders wait for this gate (released by the test), then return a stub PDF. */
  gate: Promise.resolve() as Promise<void>,
  release: (() => undefined) as () => void,
}));
vi.mock("@/lib/invoice/pdf", async (importOriginal) => {
  const real = await importOriginal<typeof PdfModule>();
  return {
    ...real,
    renderInvoicePdf: async (...args: Parameters<typeof real.renderInvoicePdf>) => {
      pdfState.calls += 1;
      if (pdfState.mode === "throw") throw Object.assign(new Error("glyph table broken near priya@sharmamedicals.example"), { code: "EGLYPH" });
      if (pdfState.mode === "held") {
        await pdfState.gate;
        return Buffer.from("%PDF-1.3\n");
      }
      if (pdfState.mode === "delay") await new Promise((resolve) => setTimeout(resolve, 200));
      if (pdfState.mode === "huge") return Buffer.concat([Buffer.from("%PDF-1.3\n"), Buffer.alloc(5 * 1024 * 1024, 0x20)]);
      return real.renderInvoicePdf(...args);
    },
  };
});

import { resendInvoices } from "@/lib/admin/orders/resend";
import { correctOrderBilling } from "@/lib/admin/orders/correction";
import { billingCorrectionBody } from "@/lib/admin/orders/schemas";
import { actorFromStaff } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  dispatchPendingEmails,
  enqueueEmail,
  EmailTemplateError,
  OUTBOX_MAX_ATTEMPTS,
  outboxBackoffMs,
  setEmailTransport,
  type EmailTransport,
  type OutgoingEmail,
} from "@/lib/email";
import { abandonedAttachmentRenders } from "@/lib/email/attachments";
import { claimDueEmails } from "@/lib/email/outbox";
import { clearDevMail, listDevMail } from "@/lib/email/dev-mailbox";
import { createConsoleTransport } from "@/lib/email/transports/console";
import { orderInvoicePdf } from "@/lib/invoice/document";
import { invoiceFileName } from "@/lib/invoice/model";
import { setLogSink } from "@/lib/log";
import { makeStaff } from "../support/admin-fixtures";
import { makeOrdersAccount, makeOrdersCatalog, paidOrder, placeOrder, type OrdersCatalog, type TestAccount } from "./admin-orders-fixtures";

type FakeTransport = EmailTransport & { sent: OutgoingEmail[] };

function fakeTransport(): FakeTransport {
  const t: FakeTransport = {
    name: "test",
    sent: [],
    async send(message) {
      t.sent.push(message);
      return { messageId: `m-${t.sent.length}` };
    },
  };
  return t;
}

let cat: OrdersCatalog;
let account: TestAccount;
let transport: FakeTransport;
let logs: string[];

beforeAll(async () => {
  cat = await makeOrdersCatalog();
  account = await makeOrdersAccount();
});

beforeEach(async () => {
  await db.outboxEmail.deleteMany({});
  transport = fakeTransport();
  setEmailTransport(transport);
  pdfState.mode = "real";
  pdfState.calls = 0;
  pdfState.gate = Promise.resolve();
  logs = [];
  setLogSink((_level, line) => logs.push(line));
});

/** Renders now wait until releaseRenders(); with a short timeout they are abandoned while still running. */
function holdRenders(): void {
  pdfState.mode = "held";
  pdfState.gate = new Promise<void>((resolve) => {
    pdfState.release = resolve;
  });
}

/** Lets held renders finish and waits until no abandoned render is left in the process (none leaks into a test). */
async function releaseRenders(): Promise<void> {
  pdfState.release();
  await vi.waitFor(() => expect(abandonedAttachmentRenders()).toBe(0), { timeout: 10_000 });
}

afterEach(async () => {
  await releaseRenders();
  setLogSink(null);
});
afterAll(() => setEmailTransport(null));

const paid = () => paidOrder({ accountId: account.accountId, items: [{ plan: cat.plans.annual }] });
const later = (ms = 1000) => new Date(Date.now() + ms);
const confirmationRow = (orderId: string) => db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey: `order_confirmation:${orderId}` } });
/** Only the order_confirmation of `orderId` stays due (the license_issued emails are not under test here). */
async function onlyConfirmation(orderId: string): Promise<void> {
  await db.outboxEmail.deleteMany({ where: { NOT: { dedupeKey: `order_confirmation:${orderId}` } } });
}
const logLines = (event: string) => logs.filter((l) => l.includes(`"event":"${event}"`)).map((l) => JSON.parse(l) as Record<string, unknown>);

/**
 * A PDF without its per-render fields (creation date, document id), so two renders of one invoice compare equal.
 */
function stableHash(pdf: Buffer): string {
  const text = pdf
    .toString("latin1")
    .replace(/\(D:\d{14}[^)]*\)/g, "(D:)")
    .replace(/\/ID\s*\[\s*<[0-9a-fA-F]*>\s*<[0-9a-fA-F]*>\s*\]/g, "/ID []");
  return createHash("sha256").update(text, "latin1").digest("hex");
}

/** The document title react-pdf writes into the PDF info ("Tax invoice AXS/26-27/0001"), an indirect string object. */
function pdfTitle(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const ref = /\/Title (\d+) 0 R/.exec(raw)?.[1];
  if (!ref) return "";
  const at = raw.indexOf(`\n${ref} 0 obj\n(`);
  return at < 0 ? "" : raw.slice(at + `\n${ref} 0 obj\n(`.length, raw.indexOf(")\nendobj", at));
}

describe("the reference on the outbox row", () => {
  it("payment stores [{ kind: invoice, orderId }] on order_confirmation only, and the claim returns it", async () => {
    const order = await paid();
    const row = await confirmationRow(order.id);
    expect(row.attachments).toEqual([{ kind: "invoice", orderId: order.id }]);
    expect(row.to).toBe(order.email);
    const others = await db.outboxEmail.findMany({ where: { NOT: { id: row.id } } });
    expect(others.length).toBeGreaterThan(0); // license_issued
    expect(others.every((r) => r.attachments === null)).toBe(true);
    expect(pdfState.calls).toBe(0); // nothing rendered inside the payment transaction

    await onlyConfirmation(order.id);
    const [claimed] = await claimDueEmails(10, later());
    expect(claimed).toMatchObject({ id: row.id, templateId: "order_confirmation", attempts: 1 });
    expect(claimed?.attachments).toEqual([{ kind: "invoice", orderId: order.id }]);
  });

  it("enqueueEmail refuses attachments a template may not carry and references of the wrong shape", async () => {
    const vars = { customer_name: "Priya", order_id: "AX-1", order_url: "http://localhost:3000/orders/AX-1?t=x", total: "₹1", invoice_number: "X" };
    const cases: unknown[] = [
      [{ kind: "invoice", orderId: "AX-1", path: "/etc/passwd" }],
      [{ kind: "invoice", orderId: "../AX-1" }],
      [{ kind: "invoice", orderId: "https://evil.example/x.pdf" }],
      [{ kind: "file", orderId: "AX-1" }],
      [{ kind: "invoice", orderId: "AX-1" }, { kind: "invoice", orderId: "AX-2" }, { kind: "invoice", orderId: "AX-3" }, { kind: "invoice", orderId: "AX-4" }, { kind: "invoice", orderId: "AX-5" }],
      { kind: "invoice", orderId: "AX-1" },
    ];
    for (const attachments of cases) {
      const error = await db
        .$transaction((tx) => enqueueEmail(tx, { to: "a@example.com", templateId: "order_confirmation", vars, attachments: attachments as never }))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmailTemplateError);
      expect((error as EmailTemplateError).reason).toBe("invalid_attachments");
    }
    const paymentFailed = await db
      .$transaction((tx) =>
        enqueueEmail(tx, { to: "a@example.com", templateId: "payment_failed", vars: { ...vars, retry_url: "x" }, attachments: [{ kind: "invoice", orderId: "AX-1" }] }),
      )
      .catch((e: unknown) => e);
    expect((paymentFailed as EmailTemplateError).reason).toBe("invalid_attachments");
    expect(await db.outboxEmail.count()).toBe(0);
  });
});

describe("dispatch", () => {
  it("attaches the order's invoice: the document the invoice.pdf routes serve, same file name", async () => {
    const order = await paid();
    await onlyConfirmation(order.id);
    expect(await dispatchPendingEmails({ now: later() })).toEqual({ sent: 1, failed: 0 });
    const [mail] = transport.sent;
    const invoice = await db.invoice.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(mail?.attachments).toHaveLength(1);
    const file = mail?.attachments?.[0];
    expect(file).toMatchObject({ filename: invoiceFileName(invoice.number), contentType: "application/pdf" });
    expect(file?.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfTitle(file?.content ?? Buffer.alloc(0))).toContain(invoice.number);

    const served = await orderInvoicePdf(db, order.id);
    expect(served?.fileName).toBe(file?.filename);
    expect(stableHash(file?.content ?? Buffer.alloc(0))).toBe(stableHash(served?.pdf ?? Buffer.alloc(0)));

    expect((await confirmationRow(order.id)).status).toBe("SENT");
    const sentLog = logLines("email_sent")[0];
    expect(sentLog).toMatchObject({ template: "order_confirmation", attachments: 1 });
    expect(logs.join("\n")).not.toContain(order.email);
  });

  it("resend attaches the current invoice after a billing correction", async () => {
    const order = await paid();
    const original = await db.invoice.findUniqueOrThrow({ where: { orderId: order.id } });
    const finance = await makeStaff("FINANCE");
    const ctx = { staff: { id: finance.id, role: "FINANCE" as const }, actor: actorFromStaff(finance) };
    const { correction } = await correctOrderBilling(
      order.id,
      billingCorrectionBody.parse({ billing: { gstin: "27ABCDE1234F1Z5" }, reason: "Customer sent their GSTIN after paying" }),
      ctx,
    );
    expect(correction.newInvoiceNo).not.toBe(original.number);

    await db.outboxEmail.deleteMany({});
    expect(await resendInvoices({ ids: [order.id], actor: ctx.actor })).toMatchObject({ queued: [order.id] });
    const row = await db.outboxEmail.findFirstOrThrow({ where: { dedupeKey: { startsWith: `order_confirmation:${order.id}:resend:` } } });
    expect(row.attachments).toEqual([{ kind: "invoice", orderId: order.id }]);

    expect(await dispatchPendingEmails({ now: later() })).toEqual({ sent: 1, failed: 0 });
    const file = transport.sent[0]?.attachments?.[0];
    expect(file?.filename).toBe(invoiceFileName(correction.newInvoiceNo));
    expect(pdfTitle(file?.content ?? Buffer.alloc(0))).toContain(correction.newInvoiceNo);
    const served = await orderInvoicePdf(db, order.id);
    expect(stableHash(file?.content ?? Buffer.alloc(0))).toBe(stableHash(served?.pdf ?? Buffer.alloc(0)));
  });

  it("keeps the invoice in the dev mailbox with the console transport (names and sizes logged only)", async () => {
    const order = await paid();
    await onlyConfirmation(order.id);
    clearDevMail();
    expect(await dispatchPendingEmails({ now: later(), transport: createConsoleTransport() })).toEqual({ sent: 1, failed: 0 });
    const [mail] = listDevMail();
    const invoice = await db.invoice.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(mail?.attachments?.map((a) => [a.filename, a.contentType])).toEqual([[invoiceFileName(invoice.number), "application/pdf"]]);
    expect(mail?.attachments?.[0]?.size).toBe(mail?.attachments?.[0]?.content.length);
    const line = logLines("email_console_attachments")[0];
    expect(line).toMatchObject({ template: "order_confirmation", files: [{ name: invoiceFileName(invoice.number), bytes: mail?.attachments?.[0]?.size }] });
    expect(logs.join("\n")).not.toMatch(/ao-buyer-|is confirmed|%PDF/);
    clearDevMail();
  });
});

describe("failure policy: the PDF never blocks the email", () => {
  it("a renderer error retries once through the normal backoff, then the email goes without the PDF", async () => {
    const order = await paid();
    await onlyConfirmation(order.id);
    pdfState.mode = "throw";
    const now = later();
    expect(await dispatchPendingEmails({ now })).toEqual({ sent: 0, failed: 1 });
    expect(transport.sent).toHaveLength(0);
    const deferred = await confirmationRow(order.id);
    expect(deferred).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(deferred.sendAfter.getTime()).toBe(now.getTime() + outboxBackoffMs(1));
    expect(deferred.lastError).toContain("attachment_render_failed");
    expect(logLines("email_attachment_retry")[0]).toMatchObject({ outboxId: deferred.id, template: "order_confirmation", kind: "invoice", reason: "render_failed", attempt: 1 });

    expect(await dispatchPendingEmails({ now: deferred.sendAfter })).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.attachments).toBeUndefined();
    expect(transport.sent[0]?.templateId).toBe("order_confirmation");
    expect(await confirmationRow(order.id)).toMatchObject({ status: "SENT", attempts: 2, lastError: null });
    expect(logLines("email_attachment_skipped")[0]).toMatchObject({
      outboxId: deferred.id,
      template: "order_confirmation",
      kind: "invoice",
      reason: "render_failed",
      attempt: 2,
      error: { name: "Error", errorCode: "EGLYPH" },
    });
    // Ids, template, kind and codes only: never the address, the subject, the renderer's message or PDF bytes.
    const out = logs.join("\n");
    expect(out).not.toMatch(/priya@|ao-buyer-|is confirmed|glyph table|%PDF/);
  });

  it("a render over the timeout counts as a failure (retry, then without the PDF)", async () => {
    const order = await paid();
    await onlyConfirmation(order.id);
    holdRenders();
    const now = later();
    expect(await dispatchPendingEmails({ now, attachments: { timeoutMs: 50 } })).toEqual({ sent: 0, failed: 1 });
    const deferred = await confirmationRow(order.id);
    expect(deferred.lastError).toContain("attachment_render_timeout");
    expect(abandonedAttachmentRenders()).toBe(1); // still running in the background
    // The abandoned render finishes (its result is dropped); the retry times out again and goes without the PDF.
    await releaseRenders();
    holdRenders();
    expect(await dispatchPendingEmails({ now: deferred.sendAfter, attachments: { timeoutMs: 50 } })).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent[0]?.attachments).toBeUndefined();
    expect(logLines("email_attachment_skipped")[0]).toMatchObject({ reason: "render_timeout", attempt: 2 });
    await releaseRenders();
    expect(pdfState.calls).toBe(2);
  });

  it("starts no render while an abandoned one still runs in the process (deferred once, then without the PDF)", async () => {
    const first = await paid();
    await onlyConfirmation(first.id);
    holdRenders();
    const now = later();
    expect(await dispatchPendingEmails({ now, attachments: { timeoutMs: 50 } })).toEqual({ sent: 0, failed: 1 });
    expect(abandonedAttachmentRenders()).toBe(1);
    const deferred = await confirmationRow(first.id);

    // A second order pays meanwhile; both rows are due while the first render is still running.
    const second = await paid();
    await db.outboxEmail.deleteMany({ where: { NOT: { templateId: "order_confirmation" } } });
    expect(await dispatchPendingEmails({ now: deferred.sendAfter, attachments: { timeoutMs: 50 } })).toEqual({ sent: 1, failed: 1 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.attachments).toBeUndefined();
    expect(await confirmationRow(first.id)).toMatchObject({ status: "SENT", attempts: 2 });
    const busy = await confirmationRow(second.id);
    expect(busy).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(busy.lastError).toContain("attachment_render_busy");
    expect(logLines("email_attachment_skipped").map((l) => [l.reason, l.attempt])).toEqual([["render_busy", 2]]);
    expect(logLines("email_attachment_retry").map((l) => [l.reason, l.attempt])).toEqual([["render_timeout", 1], ["render_busy", 1]]);

    // Once the abandoned render is done, the next attempt renders again.
    await releaseRenders();
    pdfState.mode = "real";
    expect(await dispatchPendingEmails({ now: busy.sendAfter })).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent[1]?.attachments).toHaveLength(1);
    expect(pdfState.calls).toBe(2); // the abandoned render and the last one; none while busy
  });

  it("sends without the PDF at once when there is nothing to retry: no invoice, too large, wrong recipient, unknown order", async () => {
    // An order that is not paid has no invoice.
    const unpaid = await placeOrder({ accountId: account.accountId, items: [{ plan: cat.plans.annual }] });
    const vars = (id: string) => ({ customer_name: "Priya", order_id: id, order_url: `http://localhost:3000/orders/${id}?t=x`, total: "₹1", invoice_number: "-" });
    // A paid order, but the row is addressed to someone else than the order's email.
    const other = await paid();
    await db.outboxEmail.deleteMany({});
    await db.$transaction(async (tx) => {
      await enqueueEmail(tx, { to: unpaid.email, templateId: "order_confirmation", vars: vars(unpaid.id), dedupeKey: "t:unpaid", attachments: [{ kind: "invoice", orderId: unpaid.id }] });
      await enqueueEmail(tx, { to: "someone-else@example.test", templateId: "order_confirmation", vars: vars(other.id), dedupeKey: "t:mismatch", attachments: [{ kind: "invoice", orderId: other.id }] });
      await enqueueEmail(tx, { to: "x@example.test", templateId: "order_confirmation", vars: vars("AX-404"), dedupeKey: "t:missing", attachments: [{ kind: "invoice", orderId: "AX-404" }] });
    });
    expect(await dispatchPendingEmails({ now: later() })).toEqual({ sent: 3, failed: 0 });
    expect(transport.sent.every((m) => m.attachments === undefined)).toBe(true);
    const reasons = logLines("email_attachment_skipped").map((l) => [l.reason, l.attempt]);
    expect(reasons.sort()).toEqual([["invoice_unavailable", 1], ["order_not_found", 1], ["recipient_mismatch", 1]]);
    expect(pdfState.calls).toBe(0);

    // Too large: rendered, but over 5 MB.
    await db.outboxEmail.deleteMany({});
    logs.length = 0;
    pdfState.mode = "huge";
    await db.$transaction((tx) =>
      enqueueEmail(tx, { to: other.email, templateId: "order_confirmation", vars: vars(other.id), dedupeKey: "t:huge", attachments: [{ kind: "invoice", orderId: other.id }] }),
    );
    expect(await dispatchPendingEmails({ now: later() })).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent.at(-1)?.attachments).toBeUndefined();
    expect(logLines("email_attachment_skipped").map((l) => l.reason)).toEqual(["too_large"]);
  });

  it("counts render time only toward the run's budget: slow sends never cost an order its PDF", async () => {
    const order = await paid();
    await onlyConfirmation(order.id);
    // An earlier email without attachments, sent through a transport slower than the whole budget.
    await db.outboxEmail.create({
      data: { templateId: "license_issued", to: "x@example.test", subject: "S", html: "<p>h</p>", text: "t", dedupeKey: "t:plain", sendAfter: new Date(Date.now() - 60_000) },
    });
    // A second confirmation queued after it: the first render (200 ms) spends the 100 ms budget.
    const vars = { customer_name: "Priya", order_id: order.id, order_url: `http://localhost:3000/orders/${order.id}?t=x`, total: "₹1", invoice_number: "-" };
    await db.$transaction((tx) =>
      enqueueEmail(tx, { to: order.email, templateId: "order_confirmation", vars, dedupeKey: "t:second", sendAfter: new Date(Date.now() + 10), attachments: [{ kind: "invoice", orderId: order.id }] }),
    );
    const slow: EmailTransport = {
      name: "slow",
      async send(message) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return transport.send(message);
      },
    };
    pdfState.mode = "delay";
    expect(await dispatchPendingEmails({ now: later(), transport: slow, attachments: { runBudgetMs: 100 } })).toEqual({ sent: 2, failed: 1 });
    expect(transport.sent.map((m) => [m.templateId, m.attachments?.length ?? 0])).toEqual([["license_issued", 0], ["order_confirmation", 1]]);
    const second = await db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey: "t:second" } });
    expect(second).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(second.lastError).toContain("attachment_run_budget");
    expect(logLines("email_attachment_retry").map((l) => [l.reason, l.attempt])).toEqual([["run_budget", 1]]);

    // Its retry runs over budget again: it goes without the PDF.
    expect(await dispatchPendingEmails({ now: second.sendAfter, attachments: { runBudgetMs: 0 } })).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent.at(-1)?.attachments).toBeUndefined();
    expect(logLines("email_attachment_skipped").map((l) => [l.reason, l.attempt])).toEqual([["run_budget", 2]]);
    expect(pdfState.calls).toBe(1);
  });

  it("the final attempt goes without the PDF: a relay that refuses the attachment cannot fail the email", async () => {
    const order = await paid();
    await onlyConfirmation(order.id);
    const row = await confirmationRow(order.id);
    await db.outboxEmail.update({ where: { id: row.id }, data: { attempts: OUTBOX_MAX_ATTEMPTS - 2 } });
    const picky: EmailTransport = {
      name: "picky",
      async send(message) {
        if (message.attachments?.length) throw Object.assign(new Error("Message size exceeds fixed limit"), { responseCode: 552 });
        return transport.send(message);
      },
    };
    expect(await dispatchPendingEmails({ now: later(), transport: picky })).toEqual({ sent: 0, failed: 1 });
    const refused = await confirmationRow(order.id);
    expect(refused).toMatchObject({ status: "PENDING", attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    expect(await dispatchPendingEmails({ now: refused.sendAfter, transport: picky })).toEqual({ sent: 1, failed: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.attachments).toBeUndefined();
    expect(await confirmationRow(order.id)).toMatchObject({ status: "SENT", attempts: OUTBOX_MAX_ATTEMPTS, lastError: null });
    expect(logLines("email_attachment_skipped")).toEqual([
      expect.objectContaining({ outboxId: row.id, kind: "invoice", reason: "final_attempt", attempt: OUTBOX_MAX_ATTEMPTS }),
    ]);
    expect(pdfState.calls).toBe(1); // rendered for the attempt before the last only
  });

  it("ignores and logs unknown kinds and garbled references stored on a row", async () => {
    const order = await paid();
    await db.outboxEmail.deleteMany({});
    const base = { templateId: "order_confirmation", to: order.email, subject: "S", html: "<p>h</p>", text: "t", sendAfter: new Date(Date.now() - 1000) };
    await db.outboxEmail.createMany({
      data: [
        { ...base, dedupeKey: "g:1", attachments: [{ kind: "file", path: "/etc/passwd" }] },
        { ...base, dedupeKey: "g:2", attachments: { kind: "invoice", orderId: order.id } },
        { ...base, dedupeKey: "g:3", attachments: "not json at all" },
        { ...base, dedupeKey: "g:4", attachments: [{ kind: "invoice", orderId: order.id, url: "https://evil.example/x.pdf" }] },
        { ...base, dedupeKey: "g:5", templateId: "license_issued", attachments: [{ kind: "invoice", orderId: order.id }] },
      ],
    });
    expect(await dispatchPendingEmails({ now: later() })).toEqual({ sent: 5, failed: 0 });
    expect(transport.sent.every((m) => m.attachments === undefined)).toBe(true);
    expect(pdfState.calls).toBe(0);
    const skipped = logLines("email_attachment_skipped");
    expect(skipped.every((l) => l.reason === "invalid_reference")).toBe(true);
    expect(skipped.map((l) => l.problem).sort()).toEqual(["malformed", "not_a_list", "not_a_list", "not_allowed_for_template", "unknown_kind"]);
    expect(logs.join("\n")).not.toMatch(/passwd|evil\.example/);
  });
});
