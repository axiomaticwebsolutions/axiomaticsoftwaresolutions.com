import { Icon } from "@/components/icons/icon";
import { Container } from "@/components/store/container";
import { BANNER_DISMISSED_KEY, BANNER_SCRIPT } from "@/lib/security/inline-scripts";

export { BANNER_DISMISSED_KEY };

/**
 * The banner's <head> script (root layout): hides a banner already dismissed in this session before first paint and
 * handles the dismiss button. The script text is a constant allowed by its CSP hash (lib/security/inline-scripts.ts);
 * the admin-entered text travels in the data-banner-text attribute, which React escapes. Render only when the banner
 * is enabled. Server component.
 */
export function SiteBannerScript({ text }: { text: string }) {
  return <script id="site-banner-script" data-banner-text={text} dangerouslySetInnerHTML={{ __html: BANNER_SCRIPT }} />;
}

export type SiteBannerProps = {
  /** settings["content.banner"].text (render only when the banner is enabled, with SiteBannerScript in <head>). */
  text: string;
};

/**
 * Admin announcement (settings "content.banner") under the sticky header: a lavender bar the visitor can dismiss for
 * the rest of the session. A region landmark named "Announcement". Server component.
 */
export function SiteBanner({ text }: SiteBannerProps) {
  return (
    <section
      aria-label="Announcement"
      className="border-b border-lavender-line bg-lavender-bg text-lavender-fg [html[data-banner-dismissed]_&]:hidden"
    >
      <Container className="flex items-center gap-3 py-2">
        <Icon name="info" size={18} className="hidden shrink-0 sm:block" />
        <p className="m-0 min-w-0 flex-1 text-[14px] font-semibold leading-[1.45] sm:text-center">{text}</p>
        <button
          type="button"
          data-banner-dismiss=""
          aria-label="Dismiss announcement"
          className="-mr-2 grid size-9 shrink-0 cursor-pointer place-items-center rounded-10 border-0 bg-transparent text-lavender-fg transition-colors hover:bg-lavender-line"
        >
          <Icon name="close" size={18} />
        </button>
      </Container>
    </section>
  );
}
