import { CatalogIntro } from "@/components/store/catalog/catalog-intro";
import { CatalogSkeleton } from "@/components/store/catalog/catalog-skeleton";
import { Container } from "@/components/store/container";

/**
 * /software while the catalog loads: the static intro, then skeleton toolbar, filters and cards. The (catalog) route
 * group keeps this boundary off /software/[slug], so a product's notFound() still answers 404 (not a streamed 200).
 */
export default function SoftwareLoading() {
  return (
    <Container className="pb-[120px] pt-7 leading-[normal]">
      <CatalogIntro />
      <CatalogSkeleton />
    </Container>
  );
}
