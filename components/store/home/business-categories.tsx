import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { toIconName } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { SectionHeading } from "@/components/store/section-heading";
import { categoryCountLabel, HOME_CATEGORIES } from "@/content/home";
import { categoryHref } from "@/lib/storefront/derive";
import type { StoreCategory } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { HOME_OVERLINE_LINE, HOME_TONE_CLASSES, WRAP } from "./styles";

export type BusinessCategoriesProps = {
  /** Categories to show, by sortOrder (the page passes the ones with published products). */
  categories: readonly StoreCategory[];
};

const TILE = "flex flex-1 flex-col gap-3.5 rounded-20 p-6";

/**
 * "Browse by business": a tinted tile per category linking to the filtered catalog, then the dashed
 * "More on the way" tile (Home.dc.html section 3). Server.
 */
export function BusinessCategories({ categories }: BusinessCategoriesProps) {
  const { more } = HOME_CATEGORIES;
  return (
    <section aria-labelledby="cat-h" className="border-y border-line-subtle bg-white">
      <Container className="py-[clamp(56px,7vw,96px)]">
        <SectionHeading
          id="cat-h"
          size="display-section"
          overline={HOME_CATEGORIES.overline}
          title={HOME_CATEGORIES.title}
          overlineClassName={HOME_OVERLINE_LINE}
          titleClassName={WRAP}
        />
        <ul
          className="m-0 mt-9 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,230px),1fr))] gap-4 p-0"
        >
          {categories.map((category) => {
            const tone = HOME_TONE_CLASSES[category.tone];
            return (
              <li key={category.id} className="flex">
                <Link
                  href={categoryHref(category.id)}
                  className={cn(
                    TILE,
                    "border border-transparent text-ink no-underline transition-colors duration-200 hover:border-primary-accent",
                    tone.bg,
                  )}
                >
                  <span aria-hidden="true" className={cn("grid size-12 place-items-center rounded-14 bg-white", tone.fg)}>
                    <Icon name={toIconName(category.icon)} size={26} />
                  </span>
                  <span className="text-[18px] font-extrabold tracking-[-0.01em]">{category.name}</span>
                  {category.blurb ? (
                    <span className="text-[14.5px] leading-[1.55] font-medium text-ink-body">{category.blurb}</span>
                  ) : null}
                  <span className={cn("mt-auto text-[14px] font-bold", tone.fg)}>
                    {categoryCountLabel(category.productCount)} <span aria-hidden="true">→</span>
                  </span>
                </Link>
              </li>
            );
          })}
          <li className="flex">
            <div className={cn(TILE, "border-[1.5px] border-dashed border-line-input text-ink-2")}>
              <span aria-hidden="true" className="grid size-12 place-items-center rounded-14 bg-slate-bg">
                <Icon name="add" size={26} />
              </span>
              <span className="text-[18px] font-extrabold text-ink">{more.title}</span>
              <span className="text-[14.5px] leading-[1.55] font-medium">{more.body}</span>
              <Link
                href={more.href}
                className="mt-auto self-start text-[14px] font-bold text-primary-link no-underline hover:text-primary-link-hover"
              >
                {more.link} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </li>
        </ul>
      </Container>
    </section>
  );
}
