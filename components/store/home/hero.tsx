import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { HOME_CTAS, HOME_HERO } from "@/content/home";
import { demoHref } from "@/lib/storefront/derive";
import type { StoreProduct } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { HeroIllustration } from "./hero-illustration";
import { HeroProductTiles } from "./hero-products";
import { ICON_LINE_BOX } from "./styles";

export type HeroAnnouncement = { text: string; href: string };

export type HomeHeroProps = {
  /** "{Product} {major.minor} is out", linking to the product's release notes; null hides the pill. */
  announcement: HeroAnnouncement | null;
  /** Published products by rank; the first four become the hero tiles (design C). Empty -> the illustration. */
  products: readonly StoreProduct[];
  /** GST rate for the incl. prices (settings tax.gstRatePct). */
  ratePct: number;
};

/**
 * Home hero (Home.dc.html section 1; design C chosen by the owner 2026-10-08): announcement pill, display H1, body, the
 * two CTAs and three check bullets on the left; the products as pastel tiles with starting prices on the right (the
 * illustrated UI composite when there are no products). Two columns from 2 x 460px + gap, stacked below. Server.
 */
export function HomeHero({ announcement, products, ratePct }: HomeHeroProps) {
  return (
    <section aria-labelledby="hero-h" className="relative overflow-hidden">
      {/* 48px grid of hairlines, faded out with a radial mask (currentColor = the line-subtle token). */}
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0 text-line-subtle",
          "bg-[linear-gradient(currentColor_1px,transparent_1px),linear-gradient(90deg,currentColor_1px,transparent_1px)]",
          "bg-[length:48px_48px]",
          "[mask-image:radial-gradient(ellipse_70%_60%_at_70%_30%,black_30%,transparent_75%)]",
        )}
      />
      <div
        className={cn(
          "relative mx-auto grid max-w-store items-center px-4 sm:px-6",
          "grid-cols-[repeat(auto-fit,minmax(min(100%,460px),1fr))] gap-[clamp(40px,5vw,72px)]",
          "pt-[clamp(48px,7vw,96px)] pb-[clamp(56px,7vw,104px)]",
        )}
      >
        <div className="min-w-0">
          {announcement ? (
            <Link
              href={announcement.href}
              className={cn(
                "inline-flex max-w-full items-center gap-2 rounded-pill border border-line bg-white py-1.5 pr-3 pl-1.5",
                "text-[13.5px] font-semibold text-ink-2 no-underline transition-colors hover:border-primary-accent hover:text-ink",
              )}
            >
              <span className="shrink-0 rounded-pill bg-sage-bg px-[9px] py-[3px] text-[12px] font-bold text-sage-fg">
                {HOME_HERO.badge}
              </span>
              <span className="min-w-0">{announcement.text}</span>
            </Link>
          ) : null}
          <h1 id="hero-h" className={cn("m-0 text-display", announcement && "mt-[22px]")}>
            {HOME_HERO.title}
          </h1>
          <p className="mt-[22px] mb-0 max-w-[540px] text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-pretty text-ink-2">
            {HOME_HERO.body}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" className="leading-[normal]">
              <Link href="/software">
                {HOME_CTAS.explore}
                <Icon name="arrow_forward" size={20} />
              </Link>
            </Button>
            <Button asChild size="lg" variant="secondary" className="leading-[normal]">
              <Link href={demoHref()}>{HOME_CTAS.demo}</Link>
            </Button>
          </div>
          <ul
            className="m-0 mt-8 flex list-none flex-wrap gap-x-[22px] gap-y-2.5 p-0 text-[14px] font-semibold text-ink-2"
          >
            {HOME_HERO.bullets.map((bullet) => (
              <li key={bullet} className="flex items-center gap-[7px]">
                <Icon name="check_circle" size={19} className={cn("text-success", ICON_LINE_BOX[19])} />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
        {products.length > 0 ? <HeroProductTiles products={products} ratePct={ratePct} /> : <HeroIllustration />}
      </div>
    </section>
  );
}
