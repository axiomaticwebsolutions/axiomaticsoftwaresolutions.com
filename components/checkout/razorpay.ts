/**
 * Razorpay Checkout.js (decisions.md Phase 3: Checkout.js modal; the CSP in next.config.ts allows its origins).
 * loadRazorpay() adds https://checkout.razorpay.com/v1/checkout.js once per page and resolves window.Razorpay;
 * razorpayOptions() maps the order API's checkout payload to the modal options. Client-only; no secrets here (the key
 * id is public). Only the provider's own signed response leaves the modal; the server verifies it.
 */
import type { CheckoutPayload } from "@/lib/checkout/payment-attempt";
import { palette } from "@/lib/design/tokens";

export const RAZORPAY_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
export const RAZORPAY_LOAD_TIMEOUT_MS = 20_000;

export type RazorpayPayload = Extract<CheckoutPayload, { kind: "razorpay" }>;

/** The handler argument of a successful payment (Razorpay docs: "Handle success"). */
export type RazorpaySuccess = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

export type RazorpayOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill: { name: string; email: string; contact: string };
  theme: { color: string };
  handler: (response: RazorpaySuccess) => void;
  modal: { ondismiss: () => void; escape: boolean; backdropclose: boolean; confirm_close: boolean };
  retry: { enabled: boolean };
};

export type RazorpayInstance = { open: () => void; on?: (event: string, cb: (payload: unknown) => void) => void };
export type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;

type RazorpayWindow = { Razorpay?: RazorpayConstructor };

export class RazorpayLoadError extends Error {
  constructor(message = "Razorpay Checkout could not be loaded") {
    super(message);
    this.name = "RazorpayLoadError";
  }
}

let pending: Promise<RazorpayConstructor> | null = null;

/** Test hook: forget a finished or failed load. */
export function resetRazorpayLoader(): void {
  pending = null;
}

/**
 * Loads Checkout.js once. Concurrent callers share one script tag; a failed load (network, blocker, timeout) removes
 * the tag so the next call tries again.
 */
export function loadRazorpay(
  env: { document: Document; window: RazorpayWindow } = { document, window: window as unknown as RazorpayWindow },
  timeoutMs = RAZORPAY_LOAD_TIMEOUT_MS,
): Promise<RazorpayConstructor> {
  const ready = env.window.Razorpay;
  if (ready) return Promise.resolve(ready);
  pending ??= new Promise<RazorpayConstructor>((resolve, reject) => {
    const doc = env.document;
    const existing = doc.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SCRIPT_URL}"]`);
    const script = existing ?? doc.createElement("script");
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.remove();
      pending = null;
      reject(new RazorpayLoadError());
    };
    const timer = setTimeout(fail, timeoutMs);
    script.addEventListener("load", () => {
      if (settled) return;
      const ctor = env.window.Razorpay;
      if (!ctor) return fail();
      settled = true;
      clearTimeout(timer);
      resolve(ctor);
    });
    script.addEventListener("error", fail);
    if (!existing) {
      script.src = RAZORPAY_SCRIPT_URL;
      script.async = true;
      doc.head.appendChild(script);
    }
  });
  return pending;
}

/** Modal options for an order's checkout payload. Theme colour = the brand primary token. */
export function razorpayOptions(
  payload: RazorpayPayload,
  callbacks: { onSuccess: (response: RazorpaySuccess) => void; onDismiss: () => void },
): RazorpayOptions {
  return {
    key: payload.keyId,
    amount: payload.amountPaise,
    currency: payload.currency,
    name: payload.name,
    description: payload.description,
    order_id: payload.providerOrderId,
    prefill: { ...payload.prefill },
    theme: { color: palette.primary.DEFAULT },
    handler: callbacks.onSuccess,
    // Closing asks for confirmation; Escape works; a stray backdrop click does not close it.
    modal: { ondismiss: callbacks.onDismiss, escape: true, backdropclose: false, confirm_close: true },
    // Failed attempts can be retried inside the modal; the webhook records failures.
    retry: { enabled: true },
  };
}
