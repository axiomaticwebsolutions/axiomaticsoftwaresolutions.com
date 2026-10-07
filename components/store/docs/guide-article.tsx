import Link from "next/link";
import { HelpfulVote } from "@/components/store/docs/helpful-vote";
import { OsTabs } from "@/components/store/docs/os-tabs";
import { StepList } from "@/components/store/docs/step-list";
import { Alert } from "@/components/ui/alert";
import { DOC_PLATFORMS, DOC_PLATFORM_LABELS } from "@/content/docs/guides";
import type { ResolvedGuide } from "@/content/docs/values";

export type GuideArticleProps = {
  guide: ResolvedGuide;
};

/**
 * The guide card (Docs.dc.html): group overline, title (h2 under the page's "Documentation" h1), summary, the steps
 * (per operating system in tabs when the guide has them), an optional note, then "Was this helpful?" and the support
 * link. Server component with two client islands (OS tabs, helpful vote).
 */
export function GuideArticle({ guide }: GuideArticleProps) {
  const titleId = `guide-${guide.slug}-title`;
  const platformSteps = guide.platformSteps;
  return (
    <article
      aria-labelledby={titleId}
      className="rounded-24 border border-line bg-surface p-[clamp(22px,4vw,40px)]"
    >
      <p className="text-[12.5px] font-extrabold leading-[normal] tracking-[.08em] text-primary-link">{guide.group}</p>
      <h2
        id={titleId}
        className="mt-1.5 text-[clamp(24px,2.8vw,32px)] font-extrabold leading-[normal] tracking-[-0.03em]"
      >
        {guide.title}
      </h2>
      <p className="mt-2.5 text-[16.5px] leading-[1.65] text-ink-body">{guide.summary}</p>

      {platformSteps ? (
        <OsTabs
          defaultValue={DOC_PLATFORMS[0]}
          panels={DOC_PLATFORMS.map((platform) => ({
            value: platform,
            label: DOC_PLATFORM_LABELS[platform],
            content: <StepList steps={platformSteps[platform]} />,
          }))}
        />
      ) : (
        <StepList steps={guide.steps ?? []} className="mt-[22px]" />
      )}

      {guide.note ? (
        <Alert role="note" tone="warning" icon="info" className="mt-5 min-h-[60px] gap-2.5 border-0 leading-[1.6]">
          <p className="text-notice-ink">{guide.note}</p>
        </Alert>
      ) : null}

      <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle pt-[18px]">
        <HelpfulVote key={guide.slug} />
        <Link
          href="/support"
          className="rounded-6 text-[14.5px] font-bold leading-[normal] text-primary-link underline hover:text-primary-link-hover"
        >
          Still stuck? Contact support <span aria-hidden="true">→</span>
        </Link>
      </div>
    </article>
  );
}
