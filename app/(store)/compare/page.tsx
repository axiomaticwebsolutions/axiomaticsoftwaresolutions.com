import Link from "next/link";
import {
  defaultCompareIds,
  toCompareProduct,
  toSlots,
} from "@/components/store/compare/compare-model";
import { CompareView } from "@/components/store/compare/compare-view";
import { Container } from "@/components/store/container";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { parseCompareParam } from "@/lib/compare/store";
import { buildMetadata } from "@/lib/seo/metadata";
import { CATALOG_PATH } from "@/lib/storefront/catalog-filter";
import { getStoreProducts } from "@/lib/storefront/data";

// Selection-specific URLs: kept out of search results (robots.txt also disallows /compare).
export const metadata = buildMetadata({
  title: "Compare software",
  description:
    "Compare Axiomatic billing, GST invoicing and cheque printing software side by side: licenses, features, operating systems and prices.",
  path: "/compare",
  noindex: true,
});

type ComparePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * /compare?ids=a,b,c (max 3). The server renders the table for the ids in the URL, or for the first two products by
 * rank when there are none; CompareView then reconciles with the visitor's saved selection.
 */
export default async function ComparePage({ searchParams }: ComparePageProps) {
  const [params, products] = await Promise.all([searchParams, getStoreProducts()]);
  const compareProducts = products.map(toCompareProduct);
  const raw = params.ids;
  const initialSlots =
    raw === undefined
      ? toSlots(defaultCompareIds(compareProducts))
      : toSlots(parseCompareParam(Array.isArray(raw) ? raw.join(",") : raw), compareProducts);

  return (
    <Container className="pb-24 pt-7 leading-[normal]">
      <Breadcrumb>
        <BreadcrumbList className="gap-x-2">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={CATALOG_PATH}>Software</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Compare</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <h1 className="mt-[18px] text-[clamp(30px,3.6vw,42px)] font-extrabold tracking-[-0.035em]">Compare software</h1>
      <p className="mt-2.5 text-[16.5px] text-ink-2">Choose up to three products. Prices exclude GST.</p>
      <CompareView products={compareProducts} initialSlots={initialSlots} />
    </Container>
  );
}
