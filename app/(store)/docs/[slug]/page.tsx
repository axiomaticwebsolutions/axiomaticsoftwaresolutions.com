import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/seo/json-ld";
import { Container } from "@/components/store/container";
import { DocsHero } from "@/components/store/docs/docs-hero";
import { DocsSearchProvider, DocsSearchResults } from "@/components/store/docs/docs-search";
import { GuideArticle } from "@/components/store/docs/guide-article";
import type { GuideLinkGroup } from "@/components/store/docs/guide-links";
import { GuideNav } from "@/components/store/docs/guide-nav";
import { GuidePager } from "@/components/store/docs/guide-pager";
import { DOC_GUIDES, findGuide, groupByDocGroup, guideHref } from "@/content/docs/guides";
import { docsSearchIndex } from "@/content/docs/search";
import { docsValues, resolveGuides, type ResolvedGuide } from "@/content/docs/values";
import { downloadTtlSeconds } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { breadcrumbJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { getStoreProducts, getStoreSettings } from "@/lib/storefront/data";

type Params = { slug: string };
type PageProps = { params: Promise<Params> };

// No `dynamicParams = false` here (decisions.md 2026-10-08): with it, Next.js 15.5 answers 404 for a prerendered path
// once an Admin edit has called revalidateTag() for a tag this page uses (settings, catalog, faqs). The cache then
// reports a miss, and production treats a miss under `fallback: false` as "never prerendered" (NoFallbackError).
// Unknown slugs still get the 404 page from notFound() below, and Next.js does not cache those 404s.

export function generateStaticParams(): Params[] {
  return DOC_GUIDES.map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const guide = findGuide(slug);
  if (!guide) return {};
  return buildMetadata({ title: `${guide.title} · Documentation`, description: guide.summary, path: guideHref(guide.slug) });
}

/** Guides grouped for the sidebar, from the resolved (token-filled) guides. */
function navGroups(guides: readonly ResolvedGuide[]): GuideLinkGroup[] {
  return groupByDocGroup(guides).map((group) => ({
    label: group.label,
    guides: group.items.map((g) => ({ slug: g.slug, title: g.title, href: g.href })),
  }));
}

export default async function DocsGuidePage({ params }: PageProps) {
  const { slug } = await params;
  if (!findGuide(slug)) notFound();

  const [settings, products] = await Promise.all([getStoreSettings(), getStoreProducts()]);
  const env = getEnv();
  const values = docsValues({
    downloadTtlSeconds: downloadTtlSeconds(settings, env.DOWNLOAD_LINK_TTL_SECONDS),
    selfServiceResetsPerYear: settings.licensing.selfServiceResetsPerYear,
    offlineGraceDays: env.LICENSE_OFFLINE_GRACE_DAYS,
    products,
  });
  const guides = resolveGuides(values);
  const index = guides.findIndex((g) => g.slug === slug);
  const guide = guides[index];
  if (!guide) notFound();
  const prev = guides[index - 1] ?? null;
  const next = guides[index + 1] ?? null;

  return (
    <div className="leading-[normal]">
      <DocsSearchProvider index={docsSearchIndex(guides)}>
        <DocsHero guideTitle={guide.title} />
        <Container className="grid items-start gap-8 pb-24 pt-7 catalog:grid-cols-[250px_minmax(0,1fr)]">
          <GuideNav groups={navGroups(guides)} currentSlug={guide.slug} currentLabel={`${guide.group} · ${guide.title}`} />
          <div className="min-w-0">
            <DocsSearchResults>
              <GuideArticle guide={guide} />
              <GuidePager
                prev={prev ? { title: prev.title, href: prev.href } : null}
                next={next ? { title: next.title, href: next.href } : null}
              />
            </DocsSearchResults>
          </div>
        </Container>
      </DocsSearchProvider>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Documentation", path: "/docs" },
          { name: guide.title, path: guide.href },
        ])}
      />
    </div>
  );
}
