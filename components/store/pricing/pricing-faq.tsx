import Link from "next/link";
import { SectionHeading } from "@/components/store/section-heading";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { PRICING_FAQ_COPY } from "@/content/pricing";
import type { StoreFaq } from "@/lib/storefront/types";

const HEADING_ID = "pricing-faq-heading";

/**
 * "Licensing questions": single-open accordion with the first answer open (prototype faq = 0). The question is an h3
 * around the trigger button; the prototype's bare add/remove icon replaces the shared primitive's tinted tile, and the
 * question stays ink on hover (the prototype has no hover colour; same as the product page FAQ).
 */
export function PricingFaq({ faqs }: { faqs: readonly StoreFaq[] }) {
  if (faqs.length === 0) return null;
  return (
    <section aria-labelledby={HEADING_ID} className="border-y border-line-subtle bg-surface">
      {/* Prototype: max-width 880px including the side padding (narrower than the page container). */}
      <div className="mx-auto max-w-[880px] px-4 py-[clamp(48px,6vw,80px)] sm:px-6">
        <SectionHeading id={HEADING_ID} title={PRICING_FAQ_COPY.heading} titleClassName="leading-[normal]" />
        <Accordion type="single" collapsible defaultValue={faqs[0]?.id} className="mt-6 border-t border-line">
          {faqs.map((faq) => (
            <AccordionItem key={faq.id} value={faq.id} className="last:border-b">
              <AccordionTrigger className="py-5 text-[16.5px] leading-[normal] hover:text-ink [&>span]:h-[26px] [&>span]:w-auto [&>span]:rounded-none [&>span]:bg-transparent [&_svg]:size-[22px]">
                {faq.question}
              </AccordionTrigger>
              <AccordionContent className="pb-5 pr-10 text-[15.5px] leading-[1.65]">
                {faq.answer}
                {faq.href ? (
                  <>
                    {" "}
                    <Link href={faq.href} className="rounded-6 font-bold text-primary-link hover:text-primary-link-hover">
                      {PRICING_FAQ_COPY.more}
                    </Link>
                  </>
                ) : null}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
