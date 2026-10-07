"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/account/page-header";
import { DataTableEmptyState, EmptyStateAction } from "@/components/data-table";
import { BillingDetailsForm } from "./billing-form";
import { InvoiceContactsCard, PaymentHistory, PaymentMethodsCard } from "./billing-cards";
import { BILLING_COPY, type BillingView as BillingData } from "./billing-model";

export type BillingViewProps = {
  /** GET /api/account/billing data for the active account, or null when loading failed. */
  billing: BillingData | null;
  /** Team permission billing.edit (Owner, Billing admin). */
  canEdit: boolean;
};

/**
 * Billing & tax details (Customer Portal.dc.html "Billing & tax"): the details form and, beside it, invoice delivery
 * and payment methods (auto-fit columns of at least 420px), then the payment history across the full width.
 */
export function BillingView({ billing, canEdit }: BillingViewProps) {
  const router = useRouter();
  return (
    <>
      <PageHeader title={BILLING_COPY.title} description={BILLING_COPY.description} />
      {billing ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-4 animate-enter-up motion-reduce:animate-none">
          <BillingDetailsForm details={billing.details} canEdit={canEdit} />
          <div className="grid min-w-0 gap-4">
            <InvoiceContactsCard contacts={billing.invoiceContacts} />
            <PaymentMethodsCard />
          </div>
          <PaymentHistory payments={billing.payments} truncated={billing.paymentsTruncated} className="col-span-full" />
        </div>
      ) : (
        <div className="rounded-16 border border-line-alt bg-surface">
          <DataTableEmptyState
            tone="error"
            icon="error"
            action={<EmptyStateAction onClick={() => router.refresh()}>{BILLING_COPY.retry}</EmptyStateAction>}
          >
            {BILLING_COPY.loadError}
          </DataTableEmptyState>
        </div>
      )}
    </>
  );
}
