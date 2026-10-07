import Link from "next/link";
import { STORE_PATHS } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { Button } from "@/components/ui/button";
import { PRICING_CTA } from "@/content/pricing";
import { demoHref } from "@/lib/storefront/derive";

const HEADING_ID = "pricing-cta-heading";

/** Lavender band: "Not sure which license fits?" with Compare products and Talk to us (demo request). */
export function PricingCta() {
  return (
    <Container as="section" aria-labelledby={HEADING_ID} className="py-[clamp(48px,6vw,80px)]">
      <div className="flex flex-wrap items-center justify-between gap-5 rounded-28 bg-lavender-bg p-[clamp(28px,5vw,56px)]">
        <div>
          <h2
            id={HEADING_ID}
            className="m-0 text-[clamp(26px,3vw,36px)] font-extrabold leading-[normal] tracking-[-0.03em]"
          >
            {PRICING_CTA.heading}
          </h2>
          <p className="mb-0 mt-2 text-[16px] leading-[normal] text-ink-body">{PRICING_CTA.body}</p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Button
            asChild
            variant="secondary"
            size="lg"
            className="border-transparent px-[21px] py-[13px] leading-[normal]"
          >
            <Link href={STORE_PATHS.compare}>{PRICING_CTA.compare}</Link>
          </Button>
          <Button asChild size="lg" className="px-[22px] py-[14px] leading-[normal] shadow-none">
            <Link href={demoHref()}>{PRICING_CTA.talk}</Link>
          </Button>
        </div>
      </div>
    </Container>
  );
}
