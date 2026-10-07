/**
 * Opens the payment provider's checkout for an order (POST /api/checkout/orders 201 body, or the order page's
 * POST /api/checkout/orders/:id/retry). Client-only. Shared with the order page's "Try again" / "Return to payment".
 *
 * - mock (development): navigates to checkout.url (/dev/mock-checkout), which reports back to the order page itself.
 * - razorpay: loads Checkout.js once and opens the modal. Success -> POST /api/checkout/orders/:id/return with the
 *   provider's signed ids (this only moves the order to CONFIRMING; licenses come from the verified webhook), then the
 *   order page (statusUrl). Closing the modal -> POST /api/checkout/orders/:id/cancel, then the order page, which shows
 *   "Payment canceled" with "Try again". Either POST failing still lands on the order page: it polls the real status.
 */
import { apiFetch } from "@/lib/client/api";
import type { CheckoutStart } from "@/lib/checkout/payment-attempt";
import { loadRazorpay, razorpayOptions, type RazorpayConstructor, type RazorpaySuccess } from "./razorpay";

export type HostedCheckoutPhase = "redirecting" | "open" | "returning" | "canceling";

export type HostedCheckoutDeps = {
  navigate?: (url: string) => void;
  load?: () => Promise<RazorpayConstructor>;
  post?: (path: string, body: unknown) => Promise<unknown>;
  /** Progress for the caller's busy label. */
  onPhase?: (phase: HostedCheckoutPhase) => void;
};

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

function defaultPost(path: string, body: unknown): Promise<unknown> {
  return apiFetch(path, { method: "POST", body });
}

export function orderActionPath(orderId: string, action: "return" | "cancel" | "retry"): string {
  return `/api/checkout/orders/${encodeURIComponent(orderId)}/${action}`;
}

/**
 * Starts the hosted checkout. Resolves once the browser is navigating (mock) or the modal is open (Razorpay).
 * Rejects with RazorpayLoadError when Checkout.js cannot load; the order then stays AWAITING_PAYMENT.
 */
export async function startHostedCheckout(start: CheckoutStart, deps: HostedCheckoutDeps = {}): Promise<void> {
  const navigate = deps.navigate ?? defaultNavigate;
  const post = deps.post ?? defaultPost;
  const { checkout } = start;

  if (checkout.kind === "mock") {
    deps.onPhase?.("redirecting");
    navigate(checkout.url);
    return;
  }

  const Razorpay = await (deps.load ?? loadRazorpay)();
  let finished = false;
  const finish = async (phase: "returning" | "canceling", request: () => Promise<unknown>) => {
    if (finished) return;
    finished = true;
    deps.onPhase?.(phase);
    try {
      await request();
    } catch {
      // The order page shows the real status either way (webhook and reconciliation are the source of truth).
    }
    navigate(start.statusUrl);
  };

  const options = razorpayOptions(checkout, {
    onSuccess: (response: RazorpaySuccess) =>
      void finish("returning", () =>
        post(orderActionPath(start.orderId, "return"), {
          providerPaymentId: response.razorpay_payment_id,
          providerSignature: response.razorpay_signature,
          t: start.orderToken,
        }),
      ),
    onDismiss: () => void finish("canceling", () => post(orderActionPath(start.orderId, "cancel"), { t: start.orderToken })),
  });
  const instance = new Razorpay(options);
  instance.open();
  deps.onPhase?.("open");
}
