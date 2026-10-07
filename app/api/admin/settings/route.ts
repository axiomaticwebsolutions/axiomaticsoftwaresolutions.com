/**
 * GET /api/admin/settings -> AdminSettingsData { business, tax, licensing, sampleNotice, facts: { nextInvoiceNumber,
 * nextCreditNoteNumber, offlineGraceDays }, integrations: [{ id, title, provider, status, mode?, envNames, note }] }.
 * Owner only (settings.manage). Integrations report configured / not configured from env presence; no secret, host,
 * bucket or address is ever returned.
 */
import { adminRoute } from "@/lib/admin/http";
import { getAdminSettings } from "@/lib/admin/settings/service";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("settings.manage", async () => {
  return json(await getAdminSettings(db));
});
