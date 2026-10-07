import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage } from "@/components/admin/module-page";
import { SettingsView } from "@/components/admin/settings/settings-view";
import { getAdminSettings } from "@/lib/admin/settings/service";
import { db } from "@/lib/db";

export const metadata = adminPageMetadata("settings");

/** Rendered (and its data loaded) only for the Owner (AdminModulePage gate: settings.manage). */
async function SettingsSection() {
  return <SettingsView data={await getAdminSettings(db)} />;
}

/**
 * /admin/settings (Admin Console.dc.html #settings; decisions.md Phase 6 "Settings"): Owner only. Business, tax,
 * licensing and sample-notice forms (validated with lib/config, audited old -> new, storefront revalidated) and the
 * read-only integrations panel (configured / not configured from env; secrets are never shown).
 */
export default function AdminSettingsPage() {
  return (
    <AdminModulePage moduleKey="settings">
      <SettingsSection />
    </AdminModulePage>
  );
}
