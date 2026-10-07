import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container } from "@/components/store/container";
import { LegalArticle } from "@/components/store/legal/legal-article";
import { LegalDocNav } from "@/components/store/legal/legal-doc-nav";
import { LegalPrintStyles } from "@/components/store/legal/legal-print-styles";
import { LegalToc } from "@/components/store/legal/legal-toc";
import { Alert } from "@/components/ui/alert";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import {
  LEGAL_COPY,
  LEGAL_DOCUMENTS,
  LEGAL_DOC_SLUGS,
  isLegalDocSlug,
  legalDocHref,
  legalValues,
} from "@/content/legal/documents";
import { getEnv } from "@/lib/env";
import { buildMetadata } from "@/lib/seo/metadata";
import { getStoreSettings } from "@/lib/storefront/data";

type Params = { doc: string };
type PageProps = { params: Promise<Params> };

// Only terms, privacy, refund and eula exist; any other slug is a 404.
export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return LEGAL_DOC_SLUGS.map((doc) => ({ doc }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { doc: slug } = await params;
  if (!isLegalDocSlug(slug)) return {};
  const doc = LEGAL_DOCUMENTS[slug];
  return buildMetadata({ title: doc.title, description: doc.description, path: legalDocHref(slug) });
}

export default async function LegalDocPage({ params }: PageProps) {
  const { doc: slug } = await params;
  if (!isLegalDocSlug(slug)) notFound();
  const doc = LEGAL_DOCUMENTS[slug];
  const settings = await getStoreSettings();
  const values = legalValues({ business: settings.business, offlineGraceDays: getEnv().LICENSE_OFFLINE_GRACE_DAYS });

  return (
    // The legal pages are narrower than the store: 1120px including the side padding (1072px of text column).
    <Container className="max-w-[1120px] pb-24 pt-7 leading-[normal]">
      <LegalPrintStyles />
      <Breadcrumb className="print:hidden">
        <BreadcrumbList className="gap-x-2 leading-[normal]">
          <BreadcrumbItem>
            <BreadcrumbLink asChild className="text-ink-2 no-underline">
              <Link href="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-ink-2" />
          <BreadcrumbItem>{LEGAL_COPY.breadcrumb}</BreadcrumbItem>
          <BreadcrumbSeparator className="text-ink-2" />
          <BreadcrumbItem>
            <span aria-current="page" className="text-ink">
              {doc.title}
            </span>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <LegalDocNav current={slug} className="mt-5" />

      {doc.status === "sample" ? (
        <Alert role="note" tone="warning" icon="gavel" className="mt-[18px] min-h-[61px] gap-2.5 leading-[1.55]">
          <p className="text-notice-ink">
            <strong className="font-bold">{LEGAL_COPY.sampleTitle}</strong> {LEGAL_COPY.sampleBody}
          </p>
        </Alert>
      ) : null}

      <div className="mt-6 grid items-start gap-8 catalog:grid-cols-[240px_minmax(0,1fr)] print:block">
        <LegalToc sections={doc.sections} />
        <LegalArticle doc={doc} values={values} business={settings.business} />
      </div>
    </Container>
  );
}
