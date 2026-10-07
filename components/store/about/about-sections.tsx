import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { TONE_TILE_CLASSES } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { SectionHeading } from "@/components/store/section-heading";
import { Button } from "@/components/ui/button";
import { ABOUT_CONTACT, ABOUT_COMPANY, ABOUT_PRINCIPLES, ABOUT_PRODUCTS } from "@/content/about";
import type { Tone } from "@/lib/design/tokens";
import { demoHref } from "@/lib/storefront/derive";
import { cn } from "@/lib/utils";
import type { AboutProductTile, CompanyDetailRow } from "./about-model";

/** Tile backgrounds and icon colours of the "What we build" links (tone bg, white icon tile with the tone fg). */
const TONE_BG: Readonly<Record<Tone, string>> = {
  lavender: "bg-lavender-bg",
  sage: "bg-sage-bg",
  blue: "bg-blue-bg",
  peach: "bg-peach-bg",
  pink: "bg-pink-bg",
};

const TONE_FG: Readonly<Record<Tone, string>> = {
  lavender: "text-lavender-fg",
  sage: "text-sage-fg",
  blue: "text-blue-fg",
  peach: "text-peach-fg",
  pink: "text-pink-fg",
};

const PRINCIPLES_ID = "about-principles-heading";
const PRODUCTS_ID = "about-products-heading";
const COMPANY_ID = "about-company-heading";
const CONTACT_ID = "about-contact-heading";

/** "How we work": white band with four principles. */
export function AboutPrinciples() {
  return (
    <section aria-labelledby={PRINCIPLES_ID} className="border-y border-line-subtle bg-surface">
      <Container className="py-[clamp(48px,6vw,80px)]">
        <SectionHeading id={PRINCIPLES_ID} title={ABOUT_PRINCIPLES.heading} titleClassName="leading-[normal]" />
        <ul className="mb-0 mt-7 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-7 p-0">
          {ABOUT_PRINCIPLES.items.map((item) => (
            <li key={item.title}>
              <span
                aria-hidden="true"
                className={cn("grid size-11 place-items-center rounded-13", TONE_TILE_CLASSES[item.tone])}
              >
                <Icon name={item.icon} size={23} />
              </span>
              <h3 className="mb-0 mt-3.5 text-[18px] font-extrabold leading-[normal]">{item.title}</h3>
              <p className="mb-0 mt-1.5 text-[15.5px] leading-[1.6] text-ink-2">{item.body}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

/** "What we build": one tinted link tile per published product (hidden when the catalog is empty). */
export function AboutProducts({ tiles }: { tiles: readonly AboutProductTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <Container as="section" aria-labelledby={PRODUCTS_ID} className="py-[clamp(48px,6vw,80px)]">
      <SectionHeading id={PRODUCTS_ID} title={ABOUT_PRODUCTS.heading} titleClassName="leading-[normal]" />
      <ul className="mb-0 mt-6 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,270px),1fr))] gap-4 p-0">
        {tiles.map((tile) => (
          <li key={tile.id} className="flex">
            <Link
              href={tile.href}
              className={cn(
                // Prototype hover: 0 12px 30px rgba(23,32,51,.08), lighter than the shadow-card-hover token.
                "flex flex-1 items-center gap-3.5 rounded-20 p-5 text-ink no-underline transition-shadow duration-150 hover:shadow-[0_12px_30px] hover:shadow-ink/8",
                TONE_BG[tile.tone],
              )}
            >
              <span
                aria-hidden="true"
                className={cn("grid size-[46px] shrink-0 place-items-center rounded-14 bg-surface", TONE_FG[tile.tone])}
              >
                <Icon name={tile.icon} size={24} />
              </span>
              <span className="leading-[normal]">
                <span className="block font-extrabold">{tile.name}</span>
                <span className="mt-0.5 block text-[13.5px] text-ink-soft">{tile.category}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Container>
  );
}

/** Dark "Company details" card (settings.business) and the sage "Talk to us" card. */
export function AboutCompany({ rows }: { rows: readonly CompanyDetailRow[] }) {
  return (
    <Container as="section" className="pb-[clamp(56px,7vw,96px)]">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-4">
        <div className="rounded-[26px] bg-ink p-[clamp(24px,4vw,40px)] text-white">
          <h2 id={COMPANY_ID} className="m-0 text-[26px] font-extrabold leading-[normal] tracking-[-0.02em]">
            {ABOUT_COMPANY.heading}
          </h2>
          <dl className="mb-0 mt-[18px] grid gap-3 text-[15px] leading-[normal]">
            {rows.map((row) => (
              // Term column from 420px; stacked on narrow phones so the GSTIN never breaks mid-number.
              <div key={row.key} className="grid gap-1 min-[26.25rem]:grid-cols-[140px_1fr] min-[26.25rem]:gap-2.5">
                <dt className="font-bold text-admin-text">{row.term}</dt>
                <dd className="m-0 break-words font-semibold">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex flex-col justify-center gap-3 rounded-[26px] bg-sage-bg p-[clamp(24px,4vw,40px)]">
          <h2 id={CONTACT_ID} className="m-0 text-[26px] font-extrabold leading-[normal] tracking-[-0.02em]">
            {ABOUT_CONTACT.heading}
          </h2>
          <p className="m-0 text-[16px] leading-[1.6] text-ink-soft">{ABOUT_CONTACT.body}</p>
          <div className="mt-1.5 flex flex-wrap gap-2.5">
            <Button asChild className="rounded-13 px-5 py-[13px] text-base leading-[normal]">
              <Link href="/contact">{ABOUT_CONTACT.contact}</Link>
            </Button>
            <Button
              asChild
              variant="secondary"
              className="rounded-13 border-transparent px-[19px] py-3 text-base leading-[normal]"
            >
              <Link href={demoHref()}>{ABOUT_CONTACT.demo}</Link>
            </Button>
          </div>
        </div>
      </div>
    </Container>
  );
}
