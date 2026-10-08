/**
 * GET /api/admin/settings -> AdminSettingsData { business, tax, licensing, sampleNotice, facts: { nextInvoiceNumber,
 * nextCreditNoteNumber, offlineGraceDays, expiringDays }, integrations: { canManage, items: IntegrationState[], redis } }
 * (lib/admin/settings/integrations-model.ts). Needs settings.manage (the Owner). Each integration reports its source
 * (Saved in Admin / From the server file / Not configured), provider kind, mode and problem; with integrations.manage
 * also its form: non-secret values and, per secret saved in Admin, "set", the last 4 characters of long secrets, when
 * and by whom. No secret value is ever returned.
 */
import { adminRoute } from "@/lib/admin/http";
import { getAdminSettings } from "@/lib/admin/settings/service";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("settings.manage", async ({ can }) => {
  return json(await getAdminSettings(db, { canManage: can("integrations.manage") }));
});
