import type { Metadata } from "next";
import { loadLicenseList } from "@/components/account/licenses/data";
import { LicensesView } from "@/components/account/licenses/licenses-view";
import { getPortalContext } from "@/lib/portal/context";

export const metadata: Metadata = { title: "Licenses" };

/**
 * License list (decisions.md Phase 5): every license of the active business account, any team role, keys masked.
 * Search, filters and sort live in the URL (?q=&status=&product=&sort=) and run in the browser.
 */
export default async function LicensesPage() {
  const ctx = await getPortalContext();
  const data = await loadLicenseList({ accountId: ctx.account.id, role: ctx.role });
  return <LicensesView data={data} />;
}
