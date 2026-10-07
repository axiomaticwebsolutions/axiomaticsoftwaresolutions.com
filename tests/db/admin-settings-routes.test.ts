/**
 * Settings API (app/api/admin/settings/**; settings.manage = Owner): sections validated with lib/config (GSTIN with
 * its state, prefixes of 1-3 characters, download links of at most 10 minutes), one "Updated settings" audit row per
 * changed field ("old → new"), storefront revalidation, no-op saves, strict bodies, and an integrations panel that
 * never returns a secret or other env value. SiteSetting rows are shared, so every test restores them.
 */
import type * as NextCache from "next/cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as settingsGET } from "@/app/api/admin/settings/route";
import { PATCH as sectionPATCH } from "@/app/api/admin/settings/[section]/route";
import type { AdminSettingsData } from "@/lib/admin/settings/model";
import { SETTING_KEYS } from "@/lib/config";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { callRoute, errorCodeOf, makeStaff, startSession, type TestSession } from "../support/admin-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof NextCache>()),
  revalidateTag: (tag: string) => {
    revalidated.push(tag);
  },
}));

let owner: TestSession;
let saved: Map<string, unknown>;

beforeEach(async () => {
  owner = await startSession(await makeStaff("OWNER"));
  revalidated.length = 0;
  const rows = await db.siteSetting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
  saved = new Map(rows.map((r) => [r.key, r.value]));
});

afterEach(async () => {
  for (const key of SETTING_KEYS) {
    const value = saved.get(key);
    if (value === undefined) await db.siteSetting.deleteMany({ where: { key } });
    else await db.siteSetting.upsert({ where: { key }, update: { value: value as never }, create: { key, value: value as never } });
  }
});

type Json = Record<string, unknown>;
const patch = (section: string, body: unknown, session: TestSession = owner) =>
  callRoute(jar, sectionPATCH, { method: "PATCH", path: `/api/admin/settings/${section}`, params: { section }, body, session });
const fieldErrors = async (res: Response) => ((await res.json()) as { error: { fieldErrors: Record<string, string[]> } }).error.fieldErrors;
const settingsAudit = (since: Date) =>
  db.auditLog.findMany({ where: { actorId: owner.user.id, action: "Updated settings", createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });

describe("GET /api/admin/settings", () => {
  it("returns the sections, read-only facts and integration statuses without any env value", async () => {
    const res = await callRoute(jar, settingsGET, { path: "/api/admin/settings", session: owner });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as AdminSettingsData;
    expect(Object.keys(body).sort()).toEqual(["business", "facts", "integrations", "licensing", "sampleNotice", "tax"]);
    expect(body.facts.nextInvoiceNumber).toMatch(/^[A-Z0-9-]{1,3}\/\d{2}-\d{2}\/\d{4,}$/);
    // The Expiring window is a fixed fact (EXPIRING_DAYS), not a setting.
    expect(body.facts.expiringDays).toBe(60);
    expect(body.integrations.map((i) => i.id)).toEqual(["payments", "storage", "email", "redis"]);
    for (const i of body.integrations) {
      expect(["configured", "missing", "development"]).toContain(i.status);
      expect(i.envNames.every((n) => /^[A-Z][A-Z0-9_]+$/.test(n))).toBe(true);
    }
    const env = getEnv() as unknown as Record<string, unknown>;
    const secrets = ["SESSION_SECRET", "CSRF_SECRET", "PAYMENT_WEBHOOK_SECRET", "PAYMENT_KEY_ID", "PAYMENT_KEY_SECRET", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "REDIS_URL", "DATABASE_URL", "EMAIL_FROM", "LICENSE_KEY_PEPPER"];
    for (const name of secrets) {
      const value = env[name];
      if (typeof value === "string" && value.length >= 4) expect(text.includes(value), `${name} leaked`).toBe(false);
    }
  });

  it("is Owner only", async () => {
    for (const role of ["ADMIN", "SUPPORT", "FINANCE"] as const) {
      const session = await startSession(await makeStaff(role));
      const res = await callRoute(jar, settingsGET, { path: "/api/admin/settings", session });
      expect([res.status, await errorCodeOf(res)], role).toEqual([403, "forbidden"]);
      const write = await patch("tax", { gstRatePct: 5 }, session);
      expect(write.status, role).toBe(403);
    }
  });
});

describe("PATCH /api/admin/settings/:section", () => {
  it("saves changed fields, audits each one old -> new and revalidates the storefront", async () => {
    const before = (await (await callRoute(jar, settingsGET, { path: "/api/admin/settings", session: owner })).json()) as AdminSettingsData;
    const since = new Date(Date.now() - 1000);
    const res = await patch("tax", { gstRatePct: 12, sac: "998314", priceDisplay: before.tax.priceDisplay });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { section: string; value: Json; changes: Json[] };
    expect(body.section).toBe("tax");
    expect(body.value).toMatchObject({ gstRatePct: 12, sac: "998314" });
    expect(body.changes).toEqual([
      { field: "gstRatePct", label: "GST rate (%)", from: String(before.tax.gstRatePct), to: "12" },
      { field: "sac", label: "SAC code", from: before.tax.sac, to: "998314" },
    ]);
    expect(revalidated).toEqual(["settings"]);
    const rows = await settingsAudit(since);
    expect(rows.map((r) => [r.target, r.targetType, r.targetId, r.detail])).toEqual([
      ["Tax & invoicing \u00B7 GST rate (%)", "settings", "tax.gstRatePct", `${before.tax.gstRatePct} \u2192 12`],
      ["Tax & invoicing \u00B7 SAC code", "settings", "tax.sac", `${before.tax.sac} \u2192 998314`],
    ]);
    const stored = await db.siteSetting.findUniqueOrThrow({ where: { key: "tax" } });
    expect(stored.value).toMatchObject({ gstRatePct: 12, sac: "998314" });

    // The same values again: nothing written, nothing revalidated.
    revalidated.length = 0;
    const again = await patch("tax", { gstRatePct: 12, sac: "998314" });
    expect(((await again.json()) as { changes: unknown[] }).changes).toEqual([]);
    expect(revalidated).toEqual([]);
    expect(await settingsAudit(since)).toHaveLength(2);
  });

  it("validates the merged value with lib/config", async () => {
    const prefix = await patch("tax", { invoicePrefix: "ABCD" });
    expect(prefix.status).toBe(422);
    expect((await fieldErrors(prefix)).invoicePrefix).toEqual(["Use up to 3 characters: A-Z, 0-9 or -."]);
    const same = await patch("tax", { invoicePrefix: "AXT", creditNotePrefix: "AXT" });
    expect((await fieldErrors(same)).creditNotePrefix).toEqual(["Use a different prefix from invoices."]);
    const link = await patch("licensing", { downloadLinkMinutes: 11 });
    expect(Object.keys(await fieldErrors(link))).toEqual(["downloadLinkMinutes"]);
    expect((await patch("licensing", { expiringDays: 30 })).status).toBe(422);
    const gstin = await patch("business", { gstin: "29AAAAA0000A1Z5", state: "Maharashtra" });
    expect((await fieldErrors(gstin)).gstin).toEqual(["This GSTIN is registered in Karnataka, not Maharashtra."]);
    expect(revalidated).toEqual([]);

    const moved = await patch("business", { gstin: "29aaaaa0000a1z5", state: "Karnataka", supportEmail: "  Help@Axiomatic.Example " });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { value: Json }).value).toMatchObject({ gstin: "29AAAAA0000A1Z5", state: "Karnataka", supportEmail: "help@axiomatic.example" });
  });

  it("toggles the sample notice and refuses unknown fields and sections", async () => {
    const since = new Date(Date.now() - 1000);
    const current = (await (await callRoute(jar, settingsGET, { path: "/api/admin/settings", session: owner })).json()) as AdminSettingsData;
    const res = await patch("sample-notice", { enabled: !current.sampleNotice.enabled });
    expect(res.status).toBe(200);
    const rows = await settingsAudit(since);
    expect(rows.map((r) => [r.target, r.detail])).toEqual([
      ["Sample notice \u00B7 Show the sample notice", current.sampleNotice.enabled ? "On \u2192 Off" : "Off \u2192 On"],
    ]);
    const unknownField = await patch("tax", { gstRatePct: 18, PAYMENT_KEY_SECRET: "x" });
    expect([unknownField.status, await errorCodeOf(unknownField)]).toEqual([422, "validation_failed"]);
    const unknownSection = await patch("banner", { enabled: true });
    expect(unknownSection.status).toBe(404);
  });
});
