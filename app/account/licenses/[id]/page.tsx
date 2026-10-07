import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { PORTAL_PATHS } from "@/components/account/portal-nav";
import { loadLicenseDetail } from "@/components/account/licenses/data";
import { LicenseDetailView } from "@/components/account/licenses/license-detail-view";
import { getPortalContext } from "@/lib/portal/context";
import { isLicenseIdShape } from "@/lib/validation/license-actions";

type Props = {
  params: Promise<{ id: string }>;
};

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function load(rawId: string) {
  const ctx = await getPortalContext();
  const id = decodeId(rawId);
  return isLicenseIdShape(id) ? loadLicenseDetail(ctx.account.id, ctx.role, id) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const data = await load(id);
    return { title: data ? `${data.detail.license.productShortName} · ${data.detail.license.id}` : "License not found" };
  } catch (error) {
    unstable_rethrow(error);
    return { title: decodeId(id) };
  }
}

/**
 * License detail (decisions.md Phase 5): /account/licenses/[id]?tab=overview|devices|activity|renew, any team role.
 * The view reads ?tab= itself (useSearchParams), so it also follows tab clicks (history.replaceState).
 * Unknown ids and other accounts' licenses read the same: "License not found" (rendered in the page, as the
 * prototype does).
 */
export default async function LicensePage({ params }: Props) {
  const { id } = await params;
  const data = await load(id);
  if (!data) {
    return (
      <PageHeader
        title="License not found"
        description="This license isn’t on your account. It may belong to a different email."
        actions={
          <PageAction icon="arrow_back" href={PORTAL_PATHS.licenses}>
            All licenses
          </PageAction>
        }
      />
    );
  }
  return <LicenseDetailView key={data.detail.license.id} data={data} />;
}
