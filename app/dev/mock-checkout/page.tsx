import type { Metadata } from "next";
import { notFound, unstable_rethrow } from "next/navigation";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { log } from "@/lib/log";
import { formatINR } from "@/lib/money";
import { resolveOrderAccess } from "@/lib/orders/access";
import { isMockCheckoutOpen, mockCheckoutEnabled } from "@/lib/payments/mock-delivery";
import { MockCheckout, type MockCheckoutView } from "./mock-checkout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Payment \u2014 Test gateway" },
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const MAX_PARAM = 512;
const MAX_LABEL = 40;

function single(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" || trimmed.length > MAX_PARAM ? null : trimmed;
}

/** `order` is the order id from the checkout API, or a mock provider order id (MockProvider.createOrder's URL). */
async function orderIdFor(param: string): Promise<string | null> {
  if (!/^order_mock_[A-Za-z0-9]{1,64}$/.test(param)) return param;
  const payment = await db.payment.findUnique({ where: { providerOrderId: param }, select: { orderId: true, provider: true } });
  return payment?.provider === "mock" ? payment.orderId : null;
}

async function loadView(orderParam: string | null, token: string | null): Promise<MockCheckoutView> {
  const fallbackLabel = orderParam ? orderParam.slice(0, MAX_LABEL) : "\u2014";
  const invalid: MockCheckoutView = { state: "invalid", orderLabel: fallbackLabel };
  if (!orderParam) return invalid;
  try {
    const orderId = await orderIdFor(orderParam);
    if (!orderId) return invalid;
    const { order, canAct } = await resolveOrderAccess(orderId, { token });
    if (!canAct || !(await isMockCheckoutOpen(order))) return { state: "invalid", orderLabel: order.id };
    return { state: "open", orderId: order.id, orderLabel: order.id, amountLabel: formatINR(order.totalPaise), token };
  } catch (error) {
    unstable_rethrow(error);
    // 401/403/404 from the access check all read as an invalid link, like the prototype.
    if (!(error instanceof ApiError)) log.warn("mock_checkout_load_failed", { error: error instanceof Error ? error.name : "unknown" });
    return invalid;
  }
}

/**
 * Dev-only stand-in for the payment provider's hosted checkout (prototype Payment.dc.html), used with
 * PAYMENT_PROVIDER=mock. A 404 in production (app/dev/layout.tsx) and whenever another provider is configured.
 */
export default async function MockCheckoutPage({ searchParams }: { searchParams: SearchParams }) {
  if (!(await mockCheckoutEnabled())) notFound();
  const params = await searchParams;
  const view = await loadView(single(params.order), single(params.t));
  return <MockCheckout view={view} />;
}
