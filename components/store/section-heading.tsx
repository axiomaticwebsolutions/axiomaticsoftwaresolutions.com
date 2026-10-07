import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Heading sizes used by the storefront prototypes:
 * - display-section: Home sections, clamp(30px,3.4vw,42px) ("Built for the way your shop runs")
 * - section: README H2 token, clamp(28px,3vw,38px) (Pricing, Product, About sections)
 * - band: dark/tinted bands, clamp(28px,3.2vw,40px) ("Purchase, download, activate")
 * - compact: sub-sections, clamp(24px,2.6vw,32px) ("Maintenance & support plans", "Related software")
 */
const TITLE_SIZES = {
  "display-section": "text-[clamp(30px,3.4vw,42px)] leading-[1.1] tracking-[-0.03em]",
  section: "text-h2",
  band: "text-[clamp(28px,3.2vw,40px)] leading-[1.1] tracking-[-0.03em]",
  compact: "text-[clamp(24px,2.6vw,32px)] leading-[1.15] tracking-[-0.03em]",
} as const;

/** Lead paragraph that pairs with each size (Home: 17px/1.65 after 18px; product sections: 15.5px after 10px). */
const LEAD_SIZES = {
  "display-section": "mt-[18px] text-[17px] leading-[1.65]",
  section: "mt-2.5 text-[15.5px] leading-[1.6]",
  band: "mt-3.5 text-[16px] leading-[1.6]",
  compact: "mt-3 text-[16px] leading-[1.65]",
} as const;

export type SectionHeadingSize = keyof typeof TITLE_SIZES;

export type SectionHeadingProps = {
  /** Small uppercase label above the title (prototype: 12.5px/800, 0.14em tracking, primary link colour). */
  overline?: React.ReactNode;
  title: React.ReactNode;
  /** Optional paragraph under the title. */
  lead?: React.ReactNode;
  /** Id on the heading, for `aria-labelledby` on the enclosing section. */
  id?: string;
  /** Heading level (default h2). */
  as?: "h1" | "h2" | "h3";
  size?: SectionHeadingSize;
  /** onDark: lavender overline and white text for the dark "How it works" style bands. */
  tone?: "default" | "onDark";
  align?: "start" | "center";
  /** Right-aligned slot next to the heading block (e.g. the price toggle); wraps below on narrow screens. */
  actions?: React.ReactNode;
  className?: string;
  overlineClassName?: string;
  titleClassName?: string;
  leadClassName?: string;
};

/** Overline + heading + lead pattern shared by storefront sections. Server-safe. */
export function SectionHeading({
  overline,
  title,
  lead,
  id,
  as: Heading = "h2",
  size = "section",
  tone = "default",
  align = "start",
  actions,
  className,
  overlineClassName,
  titleClassName,
  leadClassName,
}: SectionHeadingProps) {
  const onDark = tone === "onDark";
  const block = (
    <div className={cn("min-w-0", align === "center" && "mx-auto text-center", !actions && className)}>
      {overline ? (
        <p
          className={cn(
            "m-0 text-[12.5px] font-extrabold uppercase leading-[1.4] tracking-[0.14em]",
            onDark ? "text-primary-accent" : "text-primary-link",
            overlineClassName,
          )}
        >
          {overline}
        </p>
      ) : null}
      <Heading
        id={id}
        className={cn("m-0 font-extrabold", TITLE_SIZES[size], overline ? "mt-2.5" : null, onDark && "text-white", titleClassName)}
      >
        {title}
      </Heading>
      {lead ? (
        <p
          className={cn(
            "mb-0 max-w-[620px]",
            LEAD_SIZES[size],
            onDark ? "text-admin-text" : "text-ink-2",
            align === "center" && "mx-auto",
            leadClassName,
          )}
        >
          {lead}
        </p>
      ) : null}
    </div>
  );

  if (!actions) return block;
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-4", className)}>
      {block}
      <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>
    </div>
  );
}
