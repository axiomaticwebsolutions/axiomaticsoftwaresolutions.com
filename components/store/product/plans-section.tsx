import Link from "next/link";
import { Price, PriceToggle, PriceVariants } from "@/components/store/price";
import { SectionHeading } from "@/components/store/section-heading";
import { Button } from "@/components/ui/button";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import { addOnPlans, mainPlans, unitLabel } from "@/lib/storefront/derive";
import type { StorePlan, StoreProduct } from "@/lib/storefront/types";
import { ACCOUNT_LICENSES_HREF, PRODUCT_COPY } from "./copy";
import { PlanCard } from "./plan-card";
import { ProductSection } from "./product-section";

export type PlansSectionProps = {
  product: StoreProduct;
  ratePct: number;
};

/** "Plans and license limits": tax note + price toggle, plan cards, then add-ons for existing licenses. */
export function PlansSection({ product, ratePct }: PlansSectionProps) {
  const plans = mainPlans(product);
  const addOns = addOnPlans(product);

  return (
    <ProductSection id="plans" labelledBy="plans-title">
      <SectionHeading
        id="plans-title"
        title={PRODUCT_COPY.plansTitle}
        titleClassName="leading-[normal]"
        lead={<PriceVariants excl={PRODUCT_COPY.plansNoteExcl(ratePct)} incl={PRODUCT_COPY.plansNoteIncl(ratePct)} />}
        leadClassName="max-w-none leading-[normal]"
        className="gap-x-4 gap-y-4"
        actions={<PriceToggle ratePct={ratePct} />}
      />
      {plans.length > 0 ? (
        <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-stretch gap-4">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              productSlug={product.id}
              productShortName={product.shortName}
              tone={product.tone}
              ratePct={ratePct}
            />
          ))}
        </div>
      ) : null}
      {addOns.length > 0 ? <AddOnsPanel addOns={addOns} ratePct={ratePct} /> : null}
    </ProductSection>
  );
}

/** Device add-ons and maintenance change an existing license, so they are bought from the account (decisions.md). */
function AddOnsPanel({ addOns, ratePct }: { addOns: readonly StorePlan[]; ratePct: number }) {
  return (
    <div className="mt-5 rounded-22 border border-line bg-surface px-6 py-[22px]">
      <h3 id="addons-title" className="m-0 text-[17px] font-extrabold">
        {PRODUCT_COPY.addOnsTitle}
      </h3>
      <ul aria-labelledby="addons-title" className="m-0 mt-3 grid list-none gap-1 p-0">
        {addOns.map((a) => (
          <li
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle py-3"
          >
            <div className="min-w-0 flex-[1_1_280px]">
              <p className="m-0 font-bold">{a.name}</p>
              {a.summary ? <p className="m-0 mt-0.5 text-[14px] text-ink-2">{a.summary}</p> : null}
            </div>
            <p className="m-0 font-extrabold">
              <Price paise={a.pricePaise} ratePct={ratePct} />{" "}
              <span className="text-[13px] font-semibold text-ink-2">{unitLabel(a)}</span>
            </p>
            <Button
              asChild
              variant="secondary"
              className="rounded-[11px] px-3.5 py-[9px] text-[14px] leading-[normal]"
            >
              <Link href={ACCOUNT_LICENSES_HREF}>
                {PRODUCT_COPY.addFromAccount}
                <VisuallyHidden>: {a.name}</VisuallyHidden>
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
