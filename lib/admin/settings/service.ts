/**
 * Admin > Settings service (settings.manage = Owner; decisions.md Phase 6 "Settings").
 *
 * - getAdminSettings: the four editable sections (lib/config getSettings, defaults applied), read-only facts (next
 *   invoice and credit note numbers, offline grace from env, the fixed Expiring window) and the integrations panel (env
 *   presence only).
 * - updateSettingsSection: one transaction with the SiteSetting row locked: the changed fields are merged into the
 *   stored value, the result is validated with lib/config settingSchemas (422 with field errors), written, and one
 *   "Updated settings" audit row per changed field records "old → new". After the commit the storefront settings
 *   cache is revalidated (revalidateTag STOREFRONT_TAGS.settings). No change -> nothing written.
 * Server-only.
 */
import "server-only";
import { revalidateTag } from "next/cache";
import type { StaffRole } from "@/generated/prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { getSettings, parseStoredSetting, settingSchemas, SETTING_DEFAULTS, type SettingKey } from "@/lib/config";
import { COUNTER_START, formatDocumentNumber } from "@/lib/counters";
import { fiscalYearLabel } from "@/lib/dates";
import { db as defaultDb, type Db } from "@/lib/db";
import { getEnv, type Env } from "@/lib/env";
import { errors, validationErrorFromZod } from "@/lib/http";
import { EXPIRING_DAYS } from "@/lib/licensing/status";
import { log } from "@/lib/log";
import { can, roleForbiddenMessage } from "@/lib/rbac";
import { STOREFRONT_TAGS } from "@/lib/storefront/data";
import { integrationStatuses } from "./integrations";
import {
  diffSection,
  SECTION_SETTING_KEYS,
  settingsSection,
  type AdminSettingsData,
  type SettingChange,
  type SettingsSectionId,
} from "./model";

/** The number `counterKey` hands out next in the financial year of `now`, formatted (null when out of range). */
async function nextDocumentNumber(client: Db, counterKey: string, start: number, prefix: string, now: Date): Promise<string | null> {
  const fy = fiscalYearLabel(now);
  const row = await client.counter.findUnique({ where: { key: `${counterKey}:${fy}` } });
  try {
    return formatDocumentNumber(prefix, fy, row?.next ?? start);
  } catch {
    return null;
  }
}

/** GET /api/admin/settings and the Settings page. */
export async function getAdminSettings(client: Db = defaultDb, opts: { env?: Env; now?: Date } = {}): Promise<AdminSettingsData> {
  const env = opts.env ?? getEnv();
  const now = opts.now ?? new Date();
  const settings = await getSettings(client);
  const [nextInvoiceNumber, nextCreditNoteNumber] = await Promise.all([
    nextDocumentNumber(client, "invoice", COUNTER_START.invoice, settings.tax.invoicePrefix, now),
    nextDocumentNumber(client, "creditnote", COUNTER_START.creditNote, settings.tax.creditNotePrefix, now),
  ]);
  return {
    business: settings.business,
    tax: settings.tax,
    licensing: settings.licensing,
    sampleNotice: settings["content.sampleNotice"],
    facts: { nextInvoiceNumber, nextCreditNoteNumber, offlineGraceDays: env.LICENSE_OFFLINE_GRACE_DAYS, expiringDays: EXPIRING_DAYS },
    integrations: integrationStatuses(env),
  };
}

export type SettingsUpdateResult = {
  section: SettingsSectionId;
  /** The section value after the save (normalised: GSTIN upper-cased, emails lower-cased, text trimmed). */
  value: Record<string, unknown>;
  changes: SettingChange[];
};

export type SettingsActor = { staff: { id: string; role: StaffRole }; actor: AuditActor };

export type UpdateSettingsOptions = {
  client?: typeof defaultDb;
  /** Called after the commit when something changed (default revalidateTag). */
  revalidate?: (tag: string) => void;
};

function defined(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
}

/** PATCH /api/admin/settings/:section with the changed fields (shape-checked by SETTINGS_PATCH_SCHEMAS). */
export async function updateSettingsSection(
  by: SettingsActor,
  id: SettingsSectionId,
  patch: Record<string, unknown>,
  opts: UpdateSettingsOptions = {},
): Promise<SettingsUpdateResult> {
  if (!can(by.staff.role, "settings.manage")) throw errors.forbidden(roleForbiddenMessage(by.staff.role));
  const client = opts.client ?? defaultDb;
  const key: SettingKey = SECTION_SETTING_KEYS[id];
  const section = settingsSection(id);
  const changesIn = defined(patch);

  const result = await client.$transaction(async (tx) => {
    // Lock the row (created with the defaults first when missing), so concurrent saves of different fields merge.
    await tx.$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value", "updatedAt")
      VALUES (${key}, ${JSON.stringify(SETTING_DEFAULTS[key])}::jsonb, now())
      ON CONFLICT ("key") DO NOTHING`;
    const rows = await tx.$queryRaw<Array<{ value: unknown }>>`SELECT "value" FROM "SiteSetting" WHERE "key" = ${key} FOR UPDATE`;
    const current = parseStoredSetting(key, rows[0]?.value) as Record<string, unknown>;
    const parsed = settingSchemas[key].safeParse({ ...current, ...changesIn });
    if (!parsed.success) throw validationErrorFromZod(parsed.error);
    const next = parsed.data as Record<string, unknown>;
    const changes = diffSection(id, current, next);
    if (changes.length === 0) return { value: current, changes };
    await tx.siteSetting.update({ where: { key }, data: { value: next as never } });
    for (const change of changes) {
      await audit(tx, by.actor, {
        action: "Updated settings",
        target: `${section.title} \u00B7 ${change.label}`,
        targetType: "settings",
        targetId: `${key}.${change.field}`,
        detail: `${change.from} \u2192 ${change.to}`,
      });
    }
    return { value: next, changes };
  });

  if (result.changes.length > 0) {
    try {
      (opts.revalidate ?? revalidateTag)(STOREFRONT_TAGS.settings);
    } catch (error) {
      // Outside a request (scripts) there is no cache to revalidate; the 5-minute revalidation catches up.
      log.warn("settings_revalidate_failed", { section: id, error: error instanceof Error ? error.message : String(error) });
    }
    log.info("settings_updated", { section: id, fields: result.changes.map((c) => c.field), by: by.staff.id });
  }
  return { section: id, value: result.value, changes: result.changes };
}
