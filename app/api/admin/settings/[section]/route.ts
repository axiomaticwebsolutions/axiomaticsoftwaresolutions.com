/**
 * PATCH /api/admin/settings/:section (business | tax | licensing | sample-notice) { ...changed fields } ->
 * { section, value, changes: [{ field, label, from, to }] }. The merged value is validated with lib/config (422
 * validation_failed with field errors, e.g. a GSTIN registered in another state or a prefix over 3 characters); each
 * changed field writes one "Updated settings" audit row "old → new"; the storefront settings cache is revalidated.
 * An empty or unchanged patch writes nothing (changes: []). 404 for unknown sections. Owner only (settings.manage).
 */
import { adminRoute } from "@/lib/admin/http";
import { isSettingsSectionId, SETTINGS_PATCH_SCHEMAS } from "@/lib/admin/settings/model";
import { updateSettingsSection } from "@/lib/admin/settings/service";
import { errors, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = adminRoute<{ section: string }>("settings.manage", async ({ params, staff, actor, body }) => {
  const section = params.section;
  if (typeof section !== "string" || !isSettingsSectionId(section)) throw errors.notFound("Settings section");
  const patch = (await body(SETTINGS_PATCH_SCHEMAS[section])) as Record<string, unknown>;
  return json(await updateSettingsSection({ staff, actor }, section, patch));
});
