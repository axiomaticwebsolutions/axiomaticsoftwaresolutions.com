/**
 * /account/billing: Billing & tax details (Customer Portal.dc.html "Billing & tax"; decisions.md Phase 5).
 * Every team role reads it (invoices.view); only Owner and Billing admin edit (billing.edit), others see the form
 * read-only with a disabled "Save details". Data comes from lib/portal/billing for the session's active account (the
 * same as GET /api/account/billing); the form saves through PATCH /api/account/billing.
 */
import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { BillingView } from "@/components/account/billing/billing-view";
import { BILLING_COPY } from "@/components/account/billing/billing-model";
import { PageHeader } from "@/components/account/page-header";
import { PermissionDenied } from "@/components/account/permission-denied";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { getBilling, type BillingView as BillingData } from "@/lib/portal/billing";
import { getPortalContext } from "@/lib/portal/context";

export const metadata: Metadata = { title: BILLING_COPY.title };

export default async function BillingPage() {
  const portal = await getPortalContext();
  if (!portal.can("invoices.view")) {
    return (
      <>
        <PageHeader title={BILLING_COPY.title} />
        <PermissionDenied area={BILLING_COPY.title} perm="invoices.view" role={portal.role} />
      </>
    );
  }
  let billing: BillingData | null = null;
  try {
    billing = await getBilling(portal.account.id, db);
  } catch (error) {
    unstable_rethrow(error);
    log.warn("portal_billing_unavailable", { error: error instanceof Error ? error.message : String(error) });
  }
  return <BillingView billing={billing} canEdit={portal.can("billing.edit")} />;
}
