import { SectionHeading } from "@/components/store/section-heading";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { HOME_FAQ } from "@/content/home";
import type { StoreFaq } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { HOME_OVERLINE_LINE, WRAP } from "./styles";

export type HomeFaqProps = {
  /** Published FAQs for page "home", by sortOrder. */
  faqs: readonly StoreFaq[];
};

/**
 * FAQ accordion on a white band, 880px wide (Home.dc.html section 7). Single-open and collapsible, first item open,
 * as in the prototype. Server component around the client Accordion primitive.
 */
export function HomeFaq({ faqs }: HomeFaqProps) {
  if (faqs.length === 0) return null;
  return (
    <section aria-labelledby="faq-h" className="border-y border-line-subtle bg-white">
      {/* 880px including the side padding, like the prototype (Container would add the padding outside). */}
      <div className="mx-auto max-w-[880px] px-4 py-[clamp(56px,7vw,96px)] sm:px-6">
        <SectionHeading
          id="faq-h"
          size="display-section"
          overline={HOME_FAQ.overline}
          title={HOME_FAQ.title}
          overlineClassName={HOME_OVERLINE_LINE}
          titleClassName={WRAP}
        />
        <Accordion type="single" collapsible defaultValue={faqs[0]?.id} className="mt-8 border-t border-line">
          {faqs.map((faq) => (
            <AccordionItem key={faq.id} value={faq.id} className="last:border-b">
              <AccordionTrigger
                className={cn("py-[22px] text-[17px] leading-[normal] [&>span]:rounded-10 [&>span]:bg-hover-lavender [&>span>svg]:size-[22px]", WRAP)}
              >
                {faq.question}
              </AccordionTrigger>
              <AccordionContent className="pr-12 pb-[22px] text-[16px] leading-[1.65]">{faq.answer}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
