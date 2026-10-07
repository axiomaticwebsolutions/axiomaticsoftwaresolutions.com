import { ProductNotFound } from "@/components/store/product/product-not-found";

/** notFound() from the product page: unknown, DRAFT and HIDDEN slugs (rendered inside the store layout). */
export default function ProductNotFoundPage() {
  return <ProductNotFound />;
}
