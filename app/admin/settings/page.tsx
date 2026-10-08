import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage } from "@/components/admin/module-page";
import { SettingsView } from "@/components/admin/settings/settings-view";
import { getAdminContext } from "@/lib/admin/context";
import { getAdminSettings } from "@/lib/admin/settings/service";
import { loadBrandingState } from "@/lib/branding/store";
import { db } from "@/lib/db";

export const metadata = adminPageMetadata("settings");

/**
 * Rendered (and its data loaded) only for staff who may open Settings (AdminModulePage gate: settings.manage). The
 * integration forms and secret hints are loaded only with integrations.manage (the Owner); anyone else gets the
 * status-only cards. The Branding card gets the uploaded logos and favicon (metadata only, never the bytes).
 */
async function SettingsSection() {
  const ctx = await getAdminContext();
  const [data, branding] = await Promise.all([getAdminSettings(db, { canManage: ctx.can("integrations.manage") }), loadBrandingState(db)]);
  return <SettingsView data={data} branding={branding} />;
}

/**
 * /admin/settings (Admin Console.dc.html #settings; decisions.md Phase 6 "Settings"; docs/admin-integrations-design.md):
 * business, tax, licensing and sample-notice forms (validated with lib/config, audited old -> new, storefront
 * revalidated), the Branding card (logos for light and dark backgrounds, favicon) and the Integrations section:
 * payments, email and storage settings saved in Admin (encrypted secrets, password re-entry, audited) with the env file
 * as the fallback, plus the read-only rate-limits card.
 */
export default function AdminSettingsPage() {
  return (
    <AdminModulePage moduleKey="settings">
      <SettingsSection />
    </AdminModulePage>
  );
}
