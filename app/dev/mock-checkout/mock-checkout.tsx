"use client";

import * as React from "react";
import Link from "next/link";
import { LogoMark } from "@/components/brand/logo";
import { Icon, type IconName } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";

export type MockCheckoutView =
  | { state: "open"; orderId: string; orderLabel: string; amountLabel: string; token: string | null }
  | { state: "invalid"; orderLabel: string };

type Method = "UPI" | "Card" | "Net banking";
type Outcome = "success" | "pending" | "failed" | "canceled";
type MockCheckoutResponse = { returnPayload?: { providerPaymentId: string; providerSignature: string }; redirectTo: string };

const METHODS: ReadonlyArray<{ value: Method; icon: IconName; sub: string }> = [
  { value: "UPI", icon: "qr_code_2", sub: "Any UPI app" },
  { value: "Card", icon: "credit_card", sub: "Debit or credit card" },
  { value: "Net banking", icon: "account_balance", sub: "All major banks" },
];

/** The prototype returns to the store after 900 ms; the API calls run inside that pause. */
const RETURN_DELAY_MS = 900;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isSafePath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//");
}

/**
 * Reports the provider return like Checkout.js would. Best effort: the signed webhook settles the order either way,
 * so a failure here never keeps the customer on the payment page.
 */
async function reportReturn(orderId: string, outcome: Outcome, res: MockCheckoutResponse, token: string | null): Promise<void> {
  const t = token ? { t: token } : {};
  const base = `/api/checkout/orders/${encodeURIComponent(orderId)}`;
  try {
    if (outcome === "success" && res.returnPayload) await apiFetch(`${base}/return`, { body: { ...res.returnPayload, ...t } });
    if (outcome === "canceled") await apiFetch(`${base}/cancel`, { body: t });
  } catch {
    // The order page shows the state the server settles on.
  }
}

function CardHeader({ orderLabel, amountLabel }: { orderLabel: string; amountLabel: string | null }) {
  return (
    <div className="flex items-center gap-3 border-b border-line-subtle px-6 py-[22px]">
      <LogoMark size={36} />
      <div className="min-w-0 flex-1">
        <div className="font-extrabold">Axiomatic Software Solutions</div>
        <div className="text-[13px] font-semibold text-ink-2">Order {orderLabel}</div>
      </div>
      <div className="text-right">
        <div className="text-xs font-bold text-ink-2">AMOUNT</div>
        {amountLabel ? <div className="text-xl font-extrabold">{amountLabel}</div> : null}
      </div>
    </div>
  );
}

function InvalidLink() {
  return (
    <div className="px-6 py-8 text-center">
      <h1 className="m-0 text-xl font-extrabold">This payment link isn’t valid</h1>
      <p className="my-4 text-ink-2">The order may already be paid or was not found.</p>
      <Link href="/cart" className="rounded-6 font-bold text-primary-link underline hover:text-primary-link-hover">
        Back to cart
      </Link>
    </div>
  );
}

function OpenCheckout({ orderId, amountLabel, token }: { orderId: string; amountLabel: string; token: string | null }) {
  const [method, setMethod] = React.useState<Method>("UPI");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function choose(outcome: Outcome) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const started = Date.now();
    try {
      const res = await apiFetch<MockCheckoutResponse>("/api/dev/mock-checkout", {
        body: { orderId, outcome, method, ...(token ? { t: token } : {}) },
      });
      await reportReturn(orderId, outcome, res, token);
      await sleep(Math.max(0, RETURN_DELAY_MS - (Date.now() - started)));
      window.location.assign(isSafePath(res.redirectTo) ? res.redirectTo : `/orders/${encodeURIComponent(orderId)}`);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiClientError ? e.message : UNEXPECTED_ERROR_MESSAGE);
    }
  }

  const outcomeButton = "h-11 rounded-12 px-3 text-base";
  return (
    <div className="px-6 pt-5 pb-6">
      <h1 className="m-0 mb-3 text-[15px] font-extrabold">
        Choose a payment method
      </h1>
      <div role="radiogroup" aria-label="Payment method" className="grid gap-2">
        {METHODS.map((m) => {
          const checked = method === m.value;
          return (
            <label
              key={m.value}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-14 p-3.5 text-left",
                "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-primary",
                checked ? "border-2 border-primary bg-lavender-soft" : "border border-line bg-surface hover:border-line-input",
              )}
            >
              <input
                type="radio"
                name="mock-payment-method"
                value={m.value}
                checked={checked}
                onChange={() => setMethod(m.value)}
                className="sr-only"
              />
              <Icon name={m.icon} size={22} className="text-lavender-fg" />
              <span className="flex-1">
                <span className="block font-extrabold">{m.value}</span>
                <span className="block text-[13px] font-semibold text-ink-2">{m.sub}</span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="mt-5 rounded-16 border border-dashed border-line-input bg-bg p-4">
        <div className="text-overline text-ink-2">SIMULATE THE OUTCOME</div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => void choose("success")}
            className="col-span-2 h-[50px] rounded-13 px-3 text-base font-extrabold whitespace-normal"
          >
            Pay {amountLabel} · succeeds
          </Button>
          <Button
            type="button"
            variant="secondary"
            aria-disabled={busy || undefined}
            onClick={() => void choose("pending")}
            className={cn(outcomeButton, "border-peach-line bg-peach-bg text-peach-fg hover:border-peach-fg")}
          >
            Bank pending
          </Button>
          <Button
            type="button"
            variant="secondary"
            aria-disabled={busy || undefined}
            onClick={() => void choose("failed")}
            className={cn(outcomeButton, "border-pink-line bg-pink-bg text-pink-fg hover:border-pink-fg")}
          >
            Payment fails
          </Button>
          <Button
            type="button"
            variant="secondary"
            aria-disabled={busy || undefined}
            onClick={() => void choose("canceled")}
            className={cn(outcomeButton, "col-span-2")}
          >
            Cancel and return to store
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-3 mb-0 text-center text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <div role="status" className="mt-4 flex items-center justify-center gap-2.5 font-bold text-ink-2 empty:mt-0">
        {busy ? (
          <>
            <Spinner size="md" />
            Returning to Axiomatic…
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Dev-only provider stand-in (prototype Payment.dc.html): method picker, simulated outcomes, invalid-link state. */
export function MockCheckout({ view }: { view: MockCheckoutView }) {
  return (
    <main className="min-h-dvh bg-slate-bg leading-[normal] text-ink">
      <p className="m-0 border-b border-peach-line bg-peach-bg px-4 py-2.5 text-center text-[13.5px] font-bold text-peach-fg">
        Test payment gateway (mock) · Stands in for the payment provider’s hosted page. No real money moves.
      </p>
      <div className="grid min-h-[calc(100dvh-42px)] place-items-center px-4 py-8">
        <div className="w-full max-w-[460px] overflow-hidden rounded-24 bg-surface shadow-menu">
          <CardHeader orderLabel={view.orderLabel} amountLabel={view.state === "open" ? view.amountLabel : null} />
          {view.state === "open" ? (
            <OpenCheckout orderId={view.orderId} amountLabel={view.amountLabel} token={view.token} />
          ) : (
            <InvalidLink />
          )}
          <div className="flex items-center gap-1.5 border-t border-line-subtle bg-bg px-6 py-3.5 text-[12.5px] text-ink-2">
            <Icon name="lock" size={16} />
            Production: Razorpay / Cashfree via the payment adapter. Card details never touch our servers.
          </div>
        </div>
      </div>
    </main>
  );
}
