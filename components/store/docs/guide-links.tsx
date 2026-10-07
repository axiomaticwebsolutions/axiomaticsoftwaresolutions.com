import Link from "next/link";
import { cn } from "@/lib/utils";

export type GuideLinkItem = { slug: string; title: string; href: string };
export type GuideLinkGroup = { label: string; guides: readonly GuideLinkItem[] };

export type GuideLinksProps = {
  groups: readonly GuideLinkGroup[];
  currentSlug: string;
  /** Prefix for the group label ids (the page renders the list twice: sidebar and narrow-screen menu). */
  idPrefix: string;
  /** Called when a link is followed (the narrow-screen menu closes itself). */
  onNavigate?: () => void;
  className?: string;
};

/**
 * Guides grouped under small uppercase labels (12px/800, 0.08em); 14.5px/700 links, radius 10, the current guide in
 * lavender with aria-current="page". Each list is labelled by its group. Used by the sidebar (server) and by the
 * narrow-screen disclosure (client), so it has no directive of its own.
 */
export function GuideLinks({ groups, currentSlug, idPrefix, onNavigate, className }: GuideLinksProps) {
  return (
    <div className={cn("grid gap-[18px]", className)}>
      {groups.map((group, groupIndex) => {
        const labelId = `${idPrefix}-group-${groupIndex}`;
        return (
          <div key={group.label}>
            <p id={labelId} className="px-2.5 pb-1.5 text-[12px] font-extrabold uppercase leading-[normal] tracking-[.08em] text-ink-2">
              {group.label}
            </p>
            <ul aria-labelledby={labelId} className="m-0 list-none p-0">
              {group.guides.map((guide) => {
                const current = guide.slug === currentSlug;
                return (
                  <li key={guide.slug}>
                    <Link
                      href={guide.href}
                      aria-current={current ? "page" : undefined}
                      onClick={onNavigate}
                      className={cn(
                        "block rounded-10 px-2.5 py-2 text-[14.5px] font-bold leading-[normal] no-underline transition-colors",
                        // Prototype hover: background only, the text stays ink-soft.
                        current ? "bg-lavender-bg text-lavender-fg" : "text-ink-soft hover:bg-hover-lavender",
                      )}
                    >
                      {guide.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
