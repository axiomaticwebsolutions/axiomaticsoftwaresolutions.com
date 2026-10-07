import type { Metadata } from "next";
import { OrderNotFound } from "@/components/store/order/order-not-found";
import { loadOrderPageData } from "@/components/store/order/order-page-data";
import { OrderPrintStyles } from "@/components/store/order/order-print-styles";
import { OrderView } from "@/components/store/order/order-view";
import { getCurrentAuth } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { resolveOrderAccessFor } from "@/lib/orders/access";
import { buildOrderStatus } from "@/lib/orders/status";
import { buildMetadata } from "@/lib/seo/metadata";

// Personal and token-bearing: never indexed (robots.txt also disallows /orders), never cached.
export const metadata: Metadata = {
  ...buildMetadata({
    title: "Order status",
    description: "Payment status, licenses and tax invoice for your Axiomatic order.",
    path: "/orders",
    noindex: true,
  }),
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type OrderPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v.trim() !== "" && v.length <= 256 ? v.trim() : null;
}

/**
 * /orders/[id]?t= (Order.dc.html): payment status, the licenses an order issued, next steps and the tax invoice.
 * Access is decided on the server (lib/orders/access): a member of the order's account, the signed-in placer of an
 * account-less order, or the order link token. Everyone else sees "Order not found" (ids cannot be probed).
 *
 * The server render never delivers license keys (allowKeyDelivery: false): the client's first status request does,
 * once, over a same-origin no-store API response, so a key never sits in HTML or the RSC payload.
 */
export default async function OrderPage({ params, searchParams }: OrderPageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const token = firstParam(query.t);
  const auth = await getCurrentAuth();

  let access;
  try {
    access = await resolveOrderAccessFor(id, { token, auth });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return (
      <OrderNotFound
        orderId={id}
        reason={error.code === "order_link_expired" ? "expired" : "not_found"}
        signedIn={auth !== null}
      />
    );
  }

  const dto = await buildOrderStatus(db, access, { allowKeyDelivery: false });
  const data = await loadOrderPageData(db, access, dto, access.viaToken ? token : null);
  return (
    <>
      <OrderPrintStyles />
      <OrderView data={data} />
    </>
  );
}
