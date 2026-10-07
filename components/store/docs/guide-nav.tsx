import { GuideLinks, type GuideLinkGroup } from "@/components/store/docs/guide-links";
import { GuideMenu } from "@/components/store/docs/guide-menu";

export type GuideNavProps = {
  groups: readonly GuideLinkGroup[];
  currentSlug: string;
  /** "{group} · {title}" of the current guide (narrow-screen button). */
  currentLabel: string;
};

/**
 * The "Guides" navigation: a sticky grouped list beside the article from 900px (sticky 24px below the header, the
 * prototype's top:132px), and a disclosure above the article on narrow screens. Server component.
 */
export function GuideNav({ groups, currentSlug, currentLabel }: GuideNavProps) {
  return (
    <nav aria-label="Guides" className="min-w-0 catalog:sticky catalog:top-[calc(var(--store-header-h)+24px)]">
      <div className="catalog:hidden">
        <GuideMenu groups={groups} currentSlug={currentSlug} currentLabel={currentLabel} />
      </div>
      <GuideLinks groups={groups} currentSlug={currentSlug} idPrefix="docs-sidebar" className="hidden catalog:grid" />
    </nav>
  );
}
