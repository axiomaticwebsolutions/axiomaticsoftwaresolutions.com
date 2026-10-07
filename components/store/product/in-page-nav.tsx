"use client";

import { useEffect, useRef, useState } from "react";
import { Container } from "@/components/store/container";
import { cn } from "@/lib/utils";
import { PRODUCT_COPY } from "./copy";
import { activeSectionId, type ProductNavSection } from "./model";

export type InPageNavProps = {
  sections: readonly ProductNavSection[];
};

/** Extra space under the sticky nav before a section counts as current (sections scroll to 18px under it). */
const SPY_SLACK_PX = 24;

/**
 * CSS variable (on <html>) with the nav's height while it is mounted. globals.css adds it to the page's
 * scroll-padding-top, so keyboard focus moving up the page stops below the nav instead of behind it (WCAG 2.4.11).
 */
export const STICKY_EXTRA_VAR = "--store-sticky-extra";

/**
 * Sticky "On this page" nav under the store header (top = --store-header-h). Scroll-spy marks the section being
 * read with aria-current="location" and keeps its link visible when the row scrolls sideways on small screens.
 */
export function InPageNav({ sections }: InPageNavProps) {
  const navRef = useRef<HTMLElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const hasSections = sections.length > 0;

  // Publish the nav height for scroll-padding; remove it when the nav goes away.
  useEffect(() => {
    const nav = navRef.current;
    if (!hasSections || !nav) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty(STICKY_EXTRA_VAR, `${nav.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    return () => {
      observer.disconnect();
      root.style.removeProperty(STICKY_EXTRA_VAR);
    };
  }, [hasSections]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const nav = navRef.current;
      if (!nav) return;
      const box = nav.getBoundingClientRect();
      // Nothing is current until the nav has reached its sticky position (the hero is still being read).
      const stuckAt = Number.parseFloat(getComputedStyle(nav).top);
      if (Number.isFinite(stuckAt) && box.top > stuckAt + 1) {
        setActive(null);
        return;
      }
      const threshold = box.bottom + SPY_SLACK_PX;
      const positions = sections.flatMap((s) => {
        const el = document.getElementById(s.id);
        return el ? [{ id: s.id, top: el.getBoundingClientRect().top }] : [];
      });
      setActive(activeSectionId(positions, threshold));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sections]);

  // Keep the current link in view inside the horizontally scrolling row (never scrolls the page itself).
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !active) return;
    const link = row.querySelector<HTMLElement>(`a[href="#${CSS.escape(active)}"]`);
    if (!link) return;
    const left = link.offsetLeft;
    const right = left + link.offsetWidth;
    if (left >= row.scrollLeft && right <= row.scrollLeft + row.clientWidth) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollTo({ left: Math.max(0, left - 16), behavior: reduce ? "auto" : "smooth" });
  }, [active]);

  if (!hasSections) return null;

  return (
    <nav
      ref={navRef}
      aria-label={PRODUCT_COPY.inPageNavLabel}
      className="sticky top-[var(--store-header-h)] z-30 border-b border-line bg-bg/94 backdrop-blur-[10px]"
    >
      <Container>
        <div
          ref={rowRef}
          className="flex gap-1 overflow-x-auto text-[14.5px] font-bold [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {sections.map((s) => {
            const current = s.id === active;
            return (
              <a
                key={s.id}
                href={`#${s.id}`}
                aria-current={current ? "location" : undefined}
                className={cn(
                  "flex-none border-b-2 px-3 py-4 leading-[normal] no-underline transition-colors duration-150",
                  "focus-visible:-outline-offset-2",
                  current
                    ? "border-primary text-ink"
                    : "border-transparent text-ink-2 hover:border-primary-accent hover:text-ink",
                )}
              >
                {s.label}
              </a>
            );
          })}
        </div>
      </Container>
    </nav>
  );
}
