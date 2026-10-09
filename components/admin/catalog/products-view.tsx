"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { AdminTable } from "@/components/admin/admin-table";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { useListState } from "@/components/data-table/use-list-state";
import { PRODUCTS_LIST } from "@/lib/admin/catalog/list-config";
import type { ListPage } from "@/lib/admin/list-query";
import type { AdminCategoryRow, AdminProductRow, CatalogFormOptions } from "@/lib/admin/catalog/types";
import { CATEGORY_PARAM, CategoryDialog } from "./category-dialog";
import { CATEGORY_COLUMNS, categoryCard, PRODUCT_COLUMNS, productCard } from "./product-columns";
import { NEW_PARAM, ProductCreateDrawer } from "./product-create";
import { ProductDrawer } from "./product-drawer";
import { exportCsv, exportHref, filterOptions, useRefresh } from "./shared";

/** Header actions: "New category" and "New product" (products.manage; disabled with "Requires ..." otherwise). */
export function ProductsActions() {
  const category = useDrawerParam(CATEGORY_PARAM);
  const create = useDrawerParam(NEW_PARAM);
  return (
    <>
      <AdminAction perm="products.manage" icon="create_new_folder" onClick={() => category.open("new")}>
        New category
      </AdminAction>
      <AdminAction perm="products.manage" variant="primary" icon="add" onClick={() => create.open("product")}>
        New product
      </AdminAction>
    </>
  );
}

const STATUS_OPTIONS = filterOptions([
  ["published", "Published"],
  ["coming_soon", "Coming soon"],
  ["hidden", "Hidden"],
  ["draft", "Draft"],
]);

type Props = {
  page: ListPage<AdminProductRow>;
  categories: AdminCategoryRow[];
  options: CatalogFormOptions;
};

/**
 * Products & categories (Admin Console.dc.html #products): the product table (server-paged, URL state), the
 * product drawer (?id=), "New product" (?new=product), and the categories card with its dialog (?category=).
 */
export function ProductsView({ page, categories, options }: Props) {
  const list = useListState(PRODUCTS_LIST);
  const drawer = useDrawerParam();
  const create = useDrawerParam(NEW_PARAM);
  const category = useDrawerParam(CATEGORY_PARAM);
  const { refresh, refreshing } = useRefresh();
  const categoryOptions = React.useMemo(() => filterOptions(categories.map((c) => [c.id, c.name] as const)), [categories]);

  return (
    <>
      <AdminTable
        caption="Products"
        columns={PRODUCT_COLUMNS}
        data={page.items}
        getRowId={(p) => p.id}
        getRowLabel={(p) => p.shortName}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        manual
        loading={list.isPending || refreshing}
        minWidth={900}
        toolbar={{
          search: { value: list.state.q, onChange: list.setQuery, placeholder: "Search products", label: "Search products" },
          filters: [
            { id: "category", label: "Category", options: categoryOptions, value: list.state.filters.category, onChange: (v) => list.setFilter("category", v) },
            { id: "status", label: "Status", options: STATUS_OPTIONS, value: list.state.filters.status, onChange: (v) => list.setFilter("status", v) },
          ],
          onClear: list.clear,
          csv: { fileName: "products.csv", onExport: () => exportCsv(exportHref("/api/admin/products/export.csv", list.state, PRODUCTS_LIST), "products.csv") },
        }}
        exportPerm="reports.export"
        resultCount={page.total}
        pagination={{ page: page.page, pageSize: page.pageSize, total: page.total, onPageChange: list.setPage, pageHref: list.pageHref }}
        onRowClick={(p) => drawer.open(p.id)}
        mobileCard={productCard}
        emptyMessage={"No products yet. Create one with “New product”."}
      />

      <section aria-labelledby="categories-heading" className="grid gap-2">
        <h2 id="categories-heading" className="m-0 mt-2 text-[15px] font-extrabold">
          Categories
        </h2>
        <AdminTable
          caption="Categories"
          columns={CATEGORY_COLUMNS}
          data={categories}
          getRowId={(c) => c.id}
          getRowLabel={(c) => c.name}
          minWidth={640}
          resultCount={null}
          onRowClick={(c) => category.open(c.id)}
          mobileCard={categoryCard}
          footer={`${categories.length} ${categories.length === 1 ? "category" : "categories"} \u00B7 shown in this order on the storefront`}
          emptyMessage={"No categories yet. Create one with “New category”."}
        />
      </section>

      <ProductDrawer id={drawer.id} open={drawer.isOpen} onOpenChange={drawer.onOpenChange} options={options} onChanged={refresh} />
      <ProductCreateDrawer open={create.isOpen && !drawer.isOpen} onOpenChange={create.onOpenChange} options={options} onCreated={refresh} />
      <CategoryDialog target={category.id} categories={categories} onOpenChange={category.onOpenChange} onChanged={refresh} />
    </>
  );
}
