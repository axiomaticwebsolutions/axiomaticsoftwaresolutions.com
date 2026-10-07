import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { STORE_PATHS, type NavProduct } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import type { BusinessSettings } from "@/lib/config";
import { istCalendarYear } from "@/lib/dates";
import { demoHref } from "@/lib/storefront/derive";

const BRAND_NAME = "Axiomatic Software Solutions";

type FooterLink = { label: string; href: string };
type FooterColumn = { id: string; title: string; links: readonly FooterLink[] };

/** Static columns after Software (prototype Site Footer). */
const STATIC_COLUMNS: readonly FooterColumn[] = [
  {
    id: "company",
    title: "Company",
    links: [
      { label: "About us", href: "/about" },
      { label: "Pricing & licensing", href: STORE_PATHS.pricing },
      { label: "Contact", href: "/contact" },
      { label: "Request a demo", href: demoHref() },
    ],
  },
  {
    id: "resources",
    title: "Resources",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Installation guides", href: "/docs/install" },
      { label: "Support center", href: "/support" },
      { label: "My account", href: "/account" },
    ],
  },
  {
    id: "legal",
    title: "Legal",
    links: [
      { label: "Terms of service", href: "/legal/terms" },
      { label: "Privacy policy", href: "/legal/privacy" },
      { label: "Refund policy", href: "/legal/refund" },
      { label: "License agreement", href: "/legal/eula" },
    ],
  },
];

/** "tel:" target for a displayable phone number, or null when it has too few digits to dial. */
export function telHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 8 ? `tel:${digits}` : null;
}

function FooterNav({ column }: { column: FooterColumn }) {
  const headingId = `footer-${column.id}`;
  return (
    <nav aria-labelledby={headingId} className="grid content-start gap-[11px] text-[14.5px] leading-[19px]">
      <h2 id={headingId} className="m-0 text-[13px] font-extrabold uppercase leading-[18px] tracking-[0.06em] text-ink">
        {column.title}
      </h2>
      <ul className="m-0 grid list-none gap-[11px] p-0">
        {column.links.map((link) => (
          <li key={link.label}>
            <Link href={link.href} className="text-ink-2 no-underline transition-colors hover:text-primary-link hover:underline">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export type SiteFooterProps = {
  /** Published products by rank (the Software column lists their short names). */
  products: readonly Pick<NavProduct, "slug" | "shortName" | "href">[];
  /** settings.business: contact lines, and the seller details once they are real (sample = false). */
  business: BusinessSettings;
  /** Clock for the copyright year (IST); tests pass a fixed date. */
  now?: Date;
};

/**
 * Storefront footer (prototype Site Footer): brand column with contact details from settings, then Software (data
 * driven), Company, Resources and Legal link columns, each a named <nav>; bottom bar with the copyright and the GST
 * note. While the business details are placeholders they carry the prototype's "placeholder" label; once they are
 * real, the bottom bar adds the seller's legal name, address and GSTIN. Server component.
 */
export function SiteFooter({ products, business, now = new Date() }: SiteFooterProps) {
  const softwareColumn: FooterColumn = {
    id: "software",
    title: "Software",
    links: [
      ...products.map((p) => ({ label: p.shortName, href: p.href })),
      { label: "All software", href: STORE_PATHS.software },
    ],
  };
  const tel = business.sample ? null : telHref(business.phone);
  const copyrightName = business.sample ? BRAND_NAME : business.legalName;
  const place = [business.city, business.pin].filter(Boolean).join(" ");
  const sellerLine = business.sample
    ? null
    : [business.legalName, [business.address, place, business.state].filter(Boolean).join(", "), `GSTIN ${business.gstin}`]
        .filter(Boolean)
        .join(" · ");

  return (
    // While the catalog's fixed compare tray is shown, extra room at the bottom lets the last links scroll above it.
    <footer className="border-t border-line bg-surface pb-[var(--compare-tray-h,0px)] text-ink">
      <Container className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,170px),1fr))] gap-9 pb-8 pt-16">
        <div className="col-span-2 min-w-[min(100%,280px)]">
          <div className="flex">
            <Logo className="gap-[11px]" />
          </div>
          <p className="mb-0 mt-[18px] max-w-[320px] text-[14.5px] leading-[1.6] text-ink-2">
            Licensed billing and business software for Indian small businesses.
          </p>
          <ul className="m-0 mt-[18px] grid list-none gap-1.5 p-0 text-[14px] font-semibold leading-[19px] text-ink-2">
            <li>
              <a
                href={`mailto:${business.supportEmail}`}
                className="text-ink-2 no-underline wrap-anywhere hover:text-primary-link hover:underline"
              >
                {business.supportEmail}
              </a>
            </li>
            {business.phone ? (
              <li>
                {tel ? (
                  <a href={tel} className="text-ink-2 no-underline hover:text-primary-link hover:underline">
                    {business.phone}
                  </a>
                ) : (
                  <>
                    {business.phone}
                    {business.sample ? " · placeholder" : null}
                  </>
                )}
              </li>
            ) : null}
          </ul>
        </div>
        <FooterNav column={softwareColumn} />
        {STATIC_COLUMNS.map((column) => (
          <FooterNav key={column.id} column={column} />
        ))}
      </Container>
      <Container className="flex flex-wrap justify-between gap-3 border-t border-line-subtle pb-8 pt-5 text-[13px] font-medium leading-[18px] text-ink-2">
        <p className="m-0">
          © {istCalendarYear(now)} {copyrightName}. All rights reserved.
        </p>
        <p className="m-0">Prices in INR. GST charged as applicable and shown at checkout.</p>
        {sellerLine ? <p className="m-0 basis-full">{sellerLine}</p> : null}
      </Container>
    </footer>
  );
}
