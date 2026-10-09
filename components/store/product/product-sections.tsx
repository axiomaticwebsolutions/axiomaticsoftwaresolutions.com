import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { toIconName } from "@/components/store/active-nav";
import { Price } from "@/components/store/price";
import { SectionHeading } from "@/components/store/section-heading";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { PLATFORM_ICONS, PLATFORM_LABELS, productHref, startingPlan, unitLabel } from "@/lib/storefront/derive";
import type { StoreFaq, StoreProduct } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { COMING_SOON_COPY, INSTALL_GUIDE_HREF, PRODUCT_COPY, type InstallStep, type PolicyCard } from "./copy";
import { ProductSection } from "./product-section";
import { PRODUCT_TONES } from "./tones";

/** H2 as in the prototype: the README section size with the browser's normal line height. */
const H2 = "leading-[normal]";
const GRID_2 = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] gap-8";

/** A coming-soon product's page says "Planned features" and "What it will do for your business". */
export function FeaturesSection({ product }: { product: StoreProduct }) {
  const t = PRODUCT_TONES[product.tone];
  const { features, benefits } = product.content;
  const title = product.comingSoon ? COMING_SOON_COPY.featuresTitle : PRODUCT_COPY.featuresTitle;
  const benefitsTitle = product.comingSoon ? COMING_SOON_COPY.benefitsTitle : PRODUCT_COPY.benefitsTitle;
  return (
    <ProductSection id="features" labelledBy="features-title" divider={false}>
      <SectionHeading id="features-title" title={title} titleClassName={H2} />
      <ul className="m-0 mt-7 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-4 p-0">
        {features.map((f) => (
          <li key={f.title} className="rounded-20 border border-line bg-surface p-6">
            <span aria-hidden="true" className={cn("grid size-11 place-items-center rounded-13", t.tile)}>
              <Icon name={toIconName(f.icon, "check_circle")} size={23} />
            </span>
            <h3 className="m-0 mt-4 text-[17px] font-extrabold">{f.title}</h3>
            <p className="m-0 mt-1.5 text-[15px] leading-[1.6] text-ink-2">{f.body}</p>
          </li>
        ))}
      </ul>
      {benefits.length > 0 ? (
        <div
          className={cn(
            "mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-6 rounded-24 p-[clamp(24px,4vw,36px)]",
            t.bg,
          )}
        >
          <h3 className="m-0 text-[22px] font-extrabold tracking-[-0.02em]">{benefitsTitle}</h3>
          <ul className="contents">
            {benefits.map((b) => (
              <li key={b.title} className="list-none">
                <p className="m-0 text-[16px] font-extrabold">{b.title}</p>
                <p className="m-0 mt-1.5 text-[15px] leading-[1.55] text-ink-soft">{b.body}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ProductSection>
  );
}

export function RequirementsSection({ product }: { product: StoreProduct }) {
  const t = PRODUCT_TONES[product.tone];
  return (
    <ProductSection id="requirements" labelledBy="requirements-title" className={GRID_2}>
      <div>
        <SectionHeading
          id="requirements-title"
          title={product.comingSoon ? COMING_SOON_COPY.requirementsTitle : PRODUCT_COPY.requirementsTitle}
          titleClassName={H2}
        />
        {product.platforms.length > 0 ? (
          <ul className="m-0 mt-3.5 flex list-none flex-wrap gap-2 p-0">
            {product.platforms.map((p) => (
              <li
                key={p}
                className={cn("flex items-center gap-1.5 rounded-10 px-3 py-[7px] text-[14px] font-bold", t.tile)}
              >
                <Icon name={PLATFORM_ICONS[p]} size={18} className="my-0.5" />
                {PLATFORM_LABELS[p]}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <dl className="m-0 self-start overflow-hidden rounded-20 border border-line bg-surface">
        {product.content.requirements.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-[minmax(120px,38%)_1fr] gap-4 border-b border-line-subtle px-5 py-3.5 text-[15px] last:border-b-0"
          >
            <dt className="font-bold text-ink-2">{r.label}</dt>
            <dd className="m-0 font-semibold">{r.value}</dd>
          </div>
        ))}
      </dl>
    </ProductSection>
  );
}

export function InstallSection({ steps }: { steps: readonly InstallStep[] }) {
  return (
    <ProductSection id="install" labelledBy="install-title">
      <SectionHeading id="install-title" title={PRODUCT_COPY.installTitle} titleClassName={H2} />
      <ol className="m-0 mt-7 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4 p-0">
        {steps.map((s, i) => (
          <li key={s.title} className="rounded-20 border border-line bg-surface p-[22px]">
            <span className="font-mono text-[13px] font-medium text-primary-link">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="m-0 mt-2.5 text-[16.5px] font-extrabold">{s.title}</h3>
            <p className="m-0 mt-1.5 text-[14.5px] leading-[1.6] text-ink-2">{s.body}</p>
          </li>
        ))}
      </ol>
      <Link
        href={INSTALL_GUIDE_HREF}
        className="mt-[18px] inline-block rounded-6 font-bold text-primary-link underline hover:text-primary-link-hover"
      >
        {PRODUCT_COPY.installGuide}
      </Link>
    </ProductSection>
  );
}

const POLICY_TONES: Record<PolicyCard["tone"], string> = {
  blue: "bg-blue-bg",
  peach: "bg-peach-bg",
  sage: "bg-sage-bg",
};

export function SupportSection({ cards }: { cards: readonly PolicyCard[] }) {
  return (
    <ProductSection id="support" labelledBy="support-title">
      <SectionHeading id="support-title" title={PRODUCT_COPY.supportTitle} titleClassName={H2} />
      <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4">
        {cards.map((c) => (
          <div key={c.title} className={cn("rounded-20 p-6", POLICY_TONES[c.tone])}>
            <h3 className="m-0 text-[17px] font-extrabold">{c.title}</h3>
            <p className="m-0 mt-2 text-[15px] leading-[1.6] text-ink-soft">{c.body}</p>
          </div>
        ))}
      </div>
    </ProductSection>
  );
}

export function FaqSection({ faqs }: { faqs: readonly StoreFaq[] }) {
  const first = faqs[0];
  if (!first) return null;
  return (
    <ProductSection id="faqs" labelledBy="faqs-title" className={GRID_2}>
      <SectionHeading id="faqs-title" title={PRODUCT_COPY.faqsTitle} titleClassName={H2} />
      <Accordion type="single" collapsible defaultValue={first.id} className="self-start border-t border-line">
        {faqs.map((f) => (
          <AccordionItem key={f.id} value={f.id} className="last:border-b">
            <AccordionTrigger
              className={cn(
                "rounded-none py-5 text-[16.5px] leading-[normal] hover:text-ink",
                "[&>span]:my-0.5 [&>span]:size-auto [&>span]:rounded-none [&>span]:bg-transparent [&_svg]:size-[22px]",
              )}
            >
              {f.question}
            </AccordionTrigger>
            <AccordionContent className="pb-5 pr-10 text-[15.5px] leading-[1.65]">
              <p className="m-0">{f.answer}</p>
              {f.href ? (
                <Link
                  href={f.href}
                  className="mt-2 inline-block rounded-6 font-bold text-primary-link underline hover:text-primary-link-hover"
                >
                  {PRODUCT_COPY.faqGuide}
                </Link>
              ) : null}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </ProductSection>
  );
}

export function RelatedSection({ products, ratePct }: { products: readonly StoreProduct[]; ratePct: number }) {
  if (products.length === 0) return null;
  return (
    <ProductSection labelledBy="related-title" data-section="related" className="pb-[clamp(72px,8vw,120px)]">
      <SectionHeading id="related-title" title={PRODUCT_COPY.relatedTitle} size="compact" titleClassName={H2} />
      <ul className="m-0 mt-[22px] grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-4 p-0">
        {products.map((r) => {
          const from = startingPlan(r);
          return (
            <li key={r.id}>
              <Link
                href={productHref(r.id)}
                className="flex items-center gap-4 rounded-20 border border-line bg-surface p-5 text-ink no-underline transition-colors duration-150 hover:border-primary-accent hover:text-ink"
              >
                <span
                  aria-hidden="true"
                  className={cn("grid size-12 flex-none place-items-center rounded-14", PRODUCT_TONES[r.tone].tile)}
                >
                  <Icon name={toIconName(r.icon)} size={25} />
                </span>
                <span className="flex-1">
                  <span className="block font-extrabold">{r.name}</span>
                  {r.comingSoon ? (
                    <span className="mt-[3px] block text-[14px] font-semibold text-lavender-fg">{` ${PRODUCT_COPY.relatedComingSoon}`}</span>
                  ) : from ? (
                    <span className="mt-[3px] block text-[14px] text-ink-2">
                      {/* Spaces inside the text nodes: Chrome drops whitespace-only nodes from the link's name. */}
                      {`${PRODUCT_COPY.from} `}
                      <Price paise={from.pricePaise} ratePct={ratePct} />
                      {` ${unitLabel(from)}`}
                    </span>
                  ) : null}
                </span>
                <Icon name="arrow_forward" size={22} className="text-primary-link" />
              </Link>
            </li>
          );
        })}
      </ul>
    </ProductSection>
  );
}
