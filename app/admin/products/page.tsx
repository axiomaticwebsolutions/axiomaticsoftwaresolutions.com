import { Suspense } from "react";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage } from "@/components/admin/module-page";
import { ProductsActions, ProductsView } from "@/components/admin/catalog/products-view";
import { CatalogTableSkeleton } from "@/components/admin/catalog/table-skeleton";
import { catalogQueryFromState, PRODUCT_DEFAULT_SORT, PRODUCT_SORTS, PRODUCTS_LIST } from "@/lib/admin/catalog/list-config";
import { catalogFormOptions, listCategories, listProducts } from "@/lib/admin/catalog/products";
import { parseListState, type SearchParamsInput } from "@/lib/url-state";

export const metadata = adminPageMetadata("products");

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Rendered only for roles that can open the module (AdminModulePage skips children otherwise). */
async function ProductsData({ searchParams }: { searchParams: SearchParams }) {
  const state = parseListState((await searchParams) as SearchParamsInput, PRODUCTS_LIST);
  const query = catalogQueryFromState(state, PRODUCT_SORTS, PRODUCT_DEFAULT_SORT);
  const [page, categories, options] = await Promise.all([listProducts(query), listCategories(), catalogFormOptions()]);
  return <ProductsView page={page} categories={categories} options={options} />;
}

/** Admin > Catalog > Products & categories (Admin Console.dc.html #products). Every staff role can view it. */
export default function AdminProductsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AdminModulePage
      moduleKey="products"
      actions={
        <Suspense>
          <ProductsActions />
        </Suspense>
      }
    >
      <Suspense fallback={<CatalogTableSkeleton />}>
        <ProductsData searchParams={searchParams} />
      </Suspense>
    </AdminModulePage>
  );
}
