import Link from "next/link";
import { toCartPlanCatalog } from "@/components/store/cart/cart-model";
import { CartView } from "@/components/store/cart/cart-view";
import { CheckoutSteps } from "@/components/store/cart/checkout-steps";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { buildMetadata } from "@/lib/seo/metadata";
import { getStoreProducts } from "@/lib/storefront/data";

export const metadata = buildMetadata({
  title: "Cart",
  description: "Review the plans in your cart before checkout. Prices exclude GST.",
  path: "/cart",
  noindex: true,
});

/**
 * /cart (Cart.dc.html). The page shell is static (cached catalog); the cart itself lives in the browser and is priced
 * by POST /api/checkout/quote on the client (CartView). Content width 1120px as prototyped.
 */
export default async function CartPage() {
  const catalog = toCartPlanCatalog(await getStoreProducts());
  return (
    <div className="mx-auto max-w-[1120px] px-4 pb-24 pt-7 leading-[normal] sm:px-6">
      <Breadcrumb>
        <BreadcrumbList className="gap-x-2">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-ink-2" />
          <BreadcrumbItem>
            <BreadcrumbPage>Cart</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <h1 className="m-0 text-[clamp(30px,3.6vw,42px)] font-extrabold tracking-[-0.035em]">Your cart</h1>
        <CheckoutSteps current={1} />
      </div>
      <CartView catalog={catalog} />
    </div>
  );
}
