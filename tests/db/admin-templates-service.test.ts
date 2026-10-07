/**
 * Admin Notification templates (decisions.md Phase 6): the catalogue with or without rows, audited edits that refuse
 * unknown {{variables}}, the active switch, and "Send test" (direct send to the signed-in staff member only, sample
 * data, 10 per hour, never through the outbox).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as testRoute from "@/app/api/admin/templates/[id]/test/route";
import { getTemplate, loadTemplates, sendTemplateTest, TEMPLATE_TEST_LIMIT, updateTemplate } from "@/lib/admin/templates/service";
import { setRateLimitStore } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { EMAIL_TEMPLATE_IDS } from "@/lib/email/defaults";
import { setEmailTransport, type OutgoingEmail } from "@/lib/email/transport";
import { callRoute, makeAdminCallers, type AdminCallers } from "../support/admin-fixtures";
import { memoryRateLimitStore } from "../support/memory-rate-limit-store";
import { auditRows, rejection, staffFixture, type StaffFixture } from "./admin-coupons-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

const sent: OutgoingEmail[] = [];
let admin: StaffFixture;
let callers: AdminCallers;
// Templates the test edits: their rows (if any) are saved first and restored afterwards (the schema is shared).
const TOUCHED = ["refund_issued", "renewal_7", "payment_failed", "ticket_reply"];
let before: Awaited<ReturnType<typeof db.notificationTemplate.findMany>> = [];

beforeAll(async () => {
  before = await db.notificationTemplate.findMany({ where: { id: { in: TOUCHED } } });
  setEmailTransport({ name: "test", send: async (m) => (sent.push(m), { messageId: `m${sent.length}` }) });
  setRateLimitStore(memoryRateLimitStore());
  admin = await staffFixture("ADMIN");
  callers = await makeAdminCallers();
});
afterAll(async () => {
  setEmailTransport(null);
  setRateLimitStore(null);
  await db.notificationTemplate.deleteMany({ where: { id: { in: TOUCHED } } });
  for (const row of before) await db.notificationTemplate.create({ data: row });
});

describe("templates", () => {
  it("lists every catalogue template, built-in ones without a row", async () => {
    const all = await loadTemplates();
    expect(all.slice(0, EMAIL_TEMPLATE_IDS.length).map((t) => t.id)).toEqual([...EMAIL_TEMPLATE_IDS]);
    const refund = all.find((t) => t.id === "refund_issued");
    expect(refund?.vars.length).toBeGreaterThan(0);
    expect(await rejection(getTemplate("no_such_template"))).toMatchObject({ status: 404 });
  });

  it("creates the row on the first save and audits Edited template", async () => {
    await db.notificationTemplate.deleteMany({ where: { id: "refund_issued" } });
    const t = await getTemplate("refund_issued");
    expect(t.status).toBe("default");
    const res = await updateTemplate("refund_issued", { subject: `${t.subject} (edited)` }, { actor: admin.actor });
    expect(res).toMatchObject({ changed: true, template: { status: "active", subject: `${t.subject} (edited)` } });
    const rows = await auditRows("template", "refund_issued");
    expect(rows.at(-1)).toMatchObject({ action: "Edited template", detail: "subject", actorId: admin.user.id });
    expect((await updateTemplate("refund_issued", { subject: `${t.subject} (edited)` }, { actor: admin.actor })).changed).toBe(false);
  });

  it("refuses placeholders the template does not know", async () => {
    const err = await rejection(updateTemplate("renewal_7", { body: "Hi {{customer_name}}, your {{password}} is {{order_id}}." }, { actor: admin.actor }));
    expect(err.status).toBe(422);
    const message = (err.details?.fieldErrors as Record<string, string[]>).body?.[0] ?? "";
    expect(message).toContain("{{password}}");
    expect(message).toContain("{{order_id}}");
  });

  it("switches to draft and back, audited Changed template status", async () => {
    const draft = await updateTemplate("payment_failed", { active: false }, { actor: admin.actor });
    expect(draft.template.status).toBe("draft");
    await updateTemplate("payment_failed", { active: true }, { actor: admin.actor });
    const rows = (await auditRows("template", "payment_failed")).slice(-2);
    expect(rows.map((r) => [r.action, r.detail])).toEqual([
      ["Changed template status", "Draft"],
      ["Changed template status", "Active"],
    ]);
  });
});

describe("send test", () => {
  it("sends the unsaved copy with sample data to the staff member only, audited, nothing queued", async () => {
    const outbox = await db.outboxEmail.count();
    sent.length = 0;
    const res = await sendTemplateTest(
      "ticket_reply",
      { subject: "Reply on {{ticket_id}} (draft)" },
      { staff: { id: admin.user.id, email: admin.user.email }, actor: admin.actor },
    );
    expect(res.sentTo).toBe(admin.user.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(admin.user.email);
    expect(sent[0]?.subject).toMatch(/^\[Test\] Reply on T-\d+ \(draft\)$/);
    expect(await db.outboxEmail.count()).toBe(outbox);
    expect((await auditRows("template", "ticket_reply")).at(-1)).toMatchObject({ action: "Sent test email" });
  });

  it("allows 10 tests per hour per staff member (then 429)", async () => {
    const staff = await staffFixture("OWNER");
    const ctx = { staff: { id: staff.user.id, email: staff.user.email }, actor: staff.actor };
    for (let i = 0; i < TEMPLATE_TEST_LIMIT; i++) await sendTemplateTest("order_confirmation", {}, ctx);
    expect(await rejection(sendTemplateTest("order_confirmation", {}, ctx))).toMatchObject({ status: 429, code: "too_many_attempts" });
  });

  it("is templates.manage only over HTTP and never takes a recipient", async () => {
    const support = await callRoute(jar, testRoute.POST, { method: "POST", path: "/api/admin/templates/order_confirmation/test", params: { id: "order_confirmation" }, body: {}, session: callers.SUPPORT });
    expect(support.status).toBe(403);
    const withTo = await callRoute(jar, testRoute.POST, {
      method: "POST",
      path: "/api/admin/templates/order_confirmation/test",
      params: { id: "order_confirmation" },
      body: { to: "someone@example.com" },
      session: callers.OWNER,
    });
    expect(withTo.status).toBe(422);
  });
});
