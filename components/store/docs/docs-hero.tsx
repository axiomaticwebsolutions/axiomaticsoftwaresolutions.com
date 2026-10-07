import Link from "next/link";
import { Container } from "@/components/store/container";
import { DocsSearchField } from "@/components/store/docs/docs-search";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from "@/components/ui/breadcrumb";

export type DocsHeroProps = {
  /** Title of the guide being read (last breadcrumb). */
  guideTitle: string;
};

/**
 * Blue band at the top of the docs (blue bg, blue line under it): breadcrumb Home / Documentation / {guide}, the
 * "Documentation" h1 and the live search field. Must be inside <DocsSearchProvider>.
 */
export function DocsHero({ guideTitle }: DocsHeroProps) {
  return (
    <div className="border-b border-blue-line bg-blue-bg">
      <Container className="pb-8 pt-7">
        <Breadcrumb>
          <BreadcrumbList className="gap-x-2 leading-[normal] text-ink-body">
            <BreadcrumbItem>
              <BreadcrumbLink asChild className="text-ink-body no-underline">
                <Link href="/">Home</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="text-ink-body" />
            <BreadcrumbItem>
              <BreadcrumbLink asChild className="text-ink-body no-underline">
                <Link href="/docs">Documentation</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="text-ink-body" />
            <BreadcrumbItem>
              <span aria-current="page" className="text-ink">
                {guideTitle}
              </span>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <h1 className="mt-4 text-[clamp(28px,3.4vw,40px)] font-extrabold leading-[normal] tracking-[-0.035em]">
          Documentation
        </h1>
        <DocsSearchField />
      </Container>
    </div>
  );
}
