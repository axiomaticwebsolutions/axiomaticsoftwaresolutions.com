import type { Metadata } from "next";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { INSTALL_GUIDE_PATH, SOFTWARE_COPY, trialSlugFrom, type TrialOffer } from "@/components/account/software/model";
import { SoftwareView } from "@/components/account/software/software-view";
import { loadTrialOffer } from "@/components/account/software/trial-offer";
import { TrialStart } from "@/components/account/software/trial-start";
import { db } from "@/lib/db";
import { currentDownloadTtl } from "@/lib/downloads/access";
import { linkMinutes } from "@/lib/downloads/model";
import { getPortalContext } from "@/lib/portal/context";
import { loadAccountSoftware } from "@/lib/software/load";

export const metadata: Metadata = { title: SOFTWARE_COPY.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Software & downloads (/account/software; Customer Portal.dc.html vSoftware, decisions.md Phase 4/5): per product the
 * account holds a license for, the eligible vs latest version, release notes with "Included" / "Needs renewal" and a
 * download button per installer (POST /api/account/downloads; Owner and Technical contact). Every role may view it.
 * `?trial=<slug>` (storefront "Start free trial") adds the trial notice and confirmation (POST /api/account/trials).
 */
export default async function SoftwarePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getPortalContext();
  const params = await searchParams;
  const slug = trialSlugFrom(params.trial);
  const accountId = ctx.account.id;
  const [view, ttlSec, offer] = await Promise.all([
    loadAccountSoftware(db, { accountId, role: ctx.role }),
    currentDownloadTtl(db),
    slug
      ? loadTrialOffer(db, accountId, slug)
      : Promise.resolve<TrialOffer | null>(params.trial !== undefined ? { state: "not_found", slug: "" } : null),
  ]);
  const minutes = linkMinutes(ttlSec);
  return (
    <>
      <PageHeader
        title={SOFTWARE_COPY.title}
        description={SOFTWARE_COPY.description(minutes)}
        actions={
          <PageAction icon="menu_book" href={INSTALL_GUIDE_PATH}>
            {SOFTWARE_COPY.installGuides}
          </PageAction>
        }
      />
      <div className="grid animate-enter-up gap-3.5">
        <TrialStart offer={offer} />
        <SoftwareView view={view} linkMinutes={minutes} />
      </div>
    </>
  );
}
