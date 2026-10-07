"use client";

import Link from "next/link";
import * as React from "react";
import { AUTH_COPY } from "@/components/auth/copy";
import { Icon } from "@/components/icons/icon";
import { buildCartRows, toRequestItems, type CartPlanCatalog } from "@/components/store/cart/cart-model";
import { fetchQuote, useQuote } from "@/components/store/cart/use-quote";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCart } from "@/lib/cart/use-cart";
import type { CheckoutStart } from "@/lib/checkout/payment-attempt";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { normalizeCouponCode } from "@/lib/pricing";
import { saveSignInPrefill } from "@/components/store/order/session-keys";
import { rememberCartOrder } from "./cart-order";
import {
  CHECKOUT_COPY,
  CHECKOUT_ERRORS,
  CHECKOUT_FIELD_ORDER,
  checkoutFieldId,
  emailTakenFormError,
  EMPTY_CHECKOUT_VALUES,
  mapServerFieldErrors,
  showFieldSummary,
  toCreateOrderBody,
  validateCheckout,
  type CheckoutErrors,
  type CheckoutFormError,
  type CheckoutValues,
} from "./checkout-form";
import { AccountSection, BillingSection, ContactSection, TermsField, type SetCheckoutValue } from "./checkout-sections";
import type { CheckoutPrefill, CheckoutViewer } from "./checkout-viewer";
import { startHostedCheckout } from "./hosted-checkout";
import { ORDER_SUMMARY_HEADING_ID, OrderSummary, type CouponView } from "./order-summary";

export const ORDERS_PATH = "/api/checkout/orders";
const SUMMARY_ID = "checkout-errors";
const FORM_ERROR_ID = "checkout-form-error";

export type CheckoutViewProps = {
  catalog: CartPlanCatalog;
  companyState: string;
  viewer: CheckoutViewer | null;
  prefill: CheckoutPrefill;
  /** Show the sample coupon codes (only while the business details are still samples). */
  showSampleCodes: boolean;
};

type FormError = CheckoutFormError;

/**
 * The form error and the field summary (both role=alert, focused when they appear). Tailwind 4: outline-hidden sets
 * --tw-outline-style to none, so the focus ring needs outline-solid again or it stays invisible. scroll-mt keeps the ring
 * inside the viewport when the alert is scrolled to the top.
 */
const ALERT_CLASS =
  "flex gap-2.5 rounded-14 bg-pink-bg px-[18px] py-3.5 font-bold text-danger outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger scroll-mt-6";
const ALERT_LINK_CLASS = "rounded-6 text-danger underline";

/** Columns: form (two thirds) + sticky summary; stacked below ~1116px, the summary after the form (prototype). */
const GRID_CLASS = "mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-start gap-6";
const MAIN_CLASS = "grid min-w-0 gap-5 min-[47rem]:col-span-2";

function CheckoutSkeleton() {
  return (
    <div className={GRID_CLASS} aria-busy="true">
      <span className="sr-only" role="status">
        {CHECKOUT_COPY.loading}
      </span>
      <div className={MAIN_CLASS}>
        {[120, 220, 300].map((h) => (
          <div key={h} className="grid content-start gap-3 rounded-22 border border-line bg-surface p-6" style={{ minHeight: h }}>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-12 w-full rounded-12" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 rounded-22 border border-line bg-surface p-6">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="mt-3 h-[54px] w-full rounded-14" />
      </div>
    </div>
  );
}

function EmptyCheckout() {
  return (
    <div className="mt-6 rounded-22 border border-dashed border-line-input bg-surface p-12 text-center">
      <h2 className="m-0 text-[21px] font-extrabold">{CHECKOUT_COPY.emptyTitle}</h2>
      <p className="text-ink-2">{CHECKOUT_COPY.emptyBody}</p>
      <Button asChild className="mt-1.5 rounded-12 px-5 py-3 text-base leading-[normal]">
        <Link href="/software">{CHECKOUT_COPY.browse}</Link>
      </Button>
    </div>
  );
}

/**
 * /checkout body (Checkout.dc.html): account, contact, billing with GSTIN, terms, and the order summary with coupon and
 * Pay. Errors appear after the first submit and then update live. Pay re-validates on the server, creates the order
 * and opens the provider checkout (startHostedCheckout); the cart is kept until the order is PAID.
 */
export function CheckoutView({ catalog, companyState, viewer: initialViewer, prefill, showSampleCodes }: CheckoutViewProps) {
  const cart = useCart();
  const items = cart.items;
  const [viewer, setViewer] = React.useState(initialViewer);
  const guest = viewer === null;
  const [values, setValues] = React.useState<CheckoutValues>(() => ({ ...EMPTY_CHECKOUT_VALUES, ...prefill }));
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<CheckoutErrors>({});
  const [formError, setFormError] = React.useState<FormError | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const [focusTarget, setFocusTarget] = React.useState<{ id: string; tick: number } | null>(null);

  const [applied, setApplied] = React.useState<{ code: string; label: string } | null>(null);
  const [couponInput, setCouponInput] = React.useState("");
  const [couponError, setCouponError] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState(false);
  const couponInputRef = React.useRef<HTMLInputElement>(null);
  const couponRemoveRef = React.useRef<HTMLButtonElement>(null);
  const accountHeadingRef = React.useRef<HTMLHeadingElement>(null);
  const pendingCouponFocus = React.useRef<"input" | "remove" | null>(null);

  const requestItems = React.useMemo(() => toRequestItems(items), [items]);
  const quoteBody = React.useMemo(
    () => ({ items: requestItems, couponCode: applied?.code ?? null }),
    [requestItems, applied],
  );
  const scope = viewer ? viewer.email : "guest";
  const quote = useQuote(quoteBody, { enabled: cart.ready && items.length > 0, scope });
  const rows = React.useMemo(() => buildCartRows(items, quote.data, catalog), [items, quote.data, catalog]);

  // The applied code stopped applying (cart changed, viewer changed, code expired): back to the field with the reason.
  const lostCoupon = applied !== null && quote.current && quote.data?.coupon?.ok === false ? quote.data.coupon : null;
  const couponView: CouponView =
    applied && !lostCoupon
      ? { mode: "applied", code: applied.code, label: quote.data?.coupon?.ok ? quote.data.coupon.label : applied.label }
      : { mode: "input", value: lostCoupon ? applied?.code ?? couponInput : couponInput, error: lostCoupon?.message ?? couponError, applying };
  const effectiveCoupon = applied && !lostCoupon ? applied.code : null;

  // Focus moves (error summary, server error, coupon controls) after the render that shows them.
  React.useEffect(() => {
    if (!focusTarget) return;
    const el = document.getElementById(focusTarget.id);
    el?.focus();
    // A smooth scroll is an animation: none for visitors who ask for reduced motion (WCAG 2.3.3).
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [focusTarget]);
  React.useEffect(() => {
    const target = pendingCouponFocus.current;
    if (!target) return;
    pendingCouponFocus.current = null;
    (target === "remove" ? couponRemoveRef.current : couponInputRef.current)?.focus();
  });

  // Back from the provider page (bfcache restore): the form must be usable again.
  React.useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const clientErrors = React.useMemo(() => (tried ? validateCheckout(values, { guest }) : {}), [tried, values, guest]);
  const errors: CheckoutErrors = {};
  for (const key of CHECKOUT_FIELD_ORDER) {
    const message = clientErrors[key] ?? serverErrors[key];
    if (message) errors[key] = message;
  }
  const summary = CHECKOUT_FIELD_ORDER.flatMap((key) => {
    const message = errors[key];
    return message ? [{ fieldId: checkoutFieldId(key), message }] : [];
  });

  const setValue: SetCheckoutValue = React.useCallback((key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => {
      const field = key === "hasGstin" ? "gstin" : key === "createAccount" ? "password" : key;
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field as keyof CheckoutErrors];
      return next;
    });
  }, []);

  function onCouponInput(value: string) {
    setCouponInput(value);
    setCouponError(null);
    if (lostCoupon) setApplied(null);
  }

  async function applyCoupon() {
    if (applying) return;
    const code = normalizeCouponCode(couponView.mode === "input" ? couponView.value : couponInput);
    if (code === "") {
      setCouponError(CHECKOUT_ERRORS.couponInvalid);
      return;
    }
    setApplying(true);
    setCouponError(null);
    try {
      const body = { items: requestItems, couponCode: code };
      const data = await fetchQuote(body);
      quote.prime(body, data);
      if (data.coupon?.ok) {
        setApplied({ code: data.coupon.code, label: data.coupon.label });
        setCouponInput(data.coupon.code);
        pendingCouponFocus.current = "remove";
      } else {
        if (applied) setApplied(null);
        setCouponInput(code);
        setCouponError(data.coupon && !data.coupon.ok ? data.coupon.message : CHECKOUT_ERRORS.couponInvalid);
      }
    } catch (error) {
      setCouponError(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setApplying(false);
    }
  }

  function removeCoupon() {
    setApplied(null);
    setCouponInput("");
    setCouponError(null);
    pendingCouponFocus.current = "input";
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setFormError(null);
    try {
      await apiFetch("/api/auth/sign-out", { method: "POST", body: {} });
      setViewer(null);
      setValues((prev) => ({
        ...prev,
        name: "",
        email: "",
        phone: "",
        business: "",
        address: "",
        city: "",
        pin: "",
        gstin: "",
        hasGstin: false,
      }));
      setServerErrors({});
      window.requestAnimationFrame(() => accountHeadingRef.current?.focus());
    } catch (error) {
      setFormError({ message: error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE });
      setFocusTarget({ id: FORM_ERROR_ID, tick: Date.now() });
    } finally {
      setSigningOut(false);
    }
  }

  function showServerError(error: unknown) {
    if (!(error instanceof ApiClientError)) {
      setFormError({ message: UNEXPECTED_ERROR_MESSAGE });
      setFocusTarget({ id: FORM_ERROR_ID, tick: Date.now() });
      return;
    }
    if (error.status === 422 && error.code === "validation_failed") {
      const mapped = mapServerFieldErrors(error.fieldErrors);
      if (mapped.coupon) {
        setApplied(null);
        if (applied) setCouponInput(applied.code);
        setCouponError(mapped.coupon);
      }
      if (Object.keys(mapped.fields).length > 0) {
        setServerErrors(mapped.fields);
        setTried(true);
        setFormError(null);
        setFocusTarget({ id: SUMMARY_ID, tick: Date.now() });
        return;
      }
      setFormError({ message: mapped.coupon ?? mapped.other ?? error.message });
    } else if (error.code === "email_taken") {
      // One alert with a "Sign in instead." link; the email field keeps its own message (the summary stays hidden).
      setServerErrors({ email: AUTH_COPY.register.emailTakenLead });
      setFormError(emailTakenFormError());
    } else {
      if (error.code === "cart_invalid") quote.retry();
      setFormError({ message: error.message });
    }
    setFocusTarget({ id: FORM_ERROR_ID, tick: Date.now() });
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const found = validateCheckout(values, { guest });
    if (Object.keys(found).length > 0) {
      setTried(true);
      setServerErrors({});
      setFormError(null);
      setFocusTarget({ id: SUMMARY_ID, tick: Date.now() });
      return;
    }
    if (rows?.some((row) => row.issue)) {
      setFormError({ message: CHECKOUT_COPY.cartInvalid });
      setFocusTarget({ id: FORM_ERROR_ID, tick: Date.now() });
      return;
    }
    setBusy(true);
    setFormError(null);
    let start: CheckoutStart;
    try {
      const body = toCreateOrderBody(values, requestItems, { couponCode: effectiveCoupon, guest });
      start = await apiFetch<CheckoutStart>(ORDERS_PATH, { method: "POST", body });
    } catch (error) {
      setBusy(false);
      showServerError(error);
      return;
    }
    rememberCartOrder(start.orderId, items);
    try {
      await startHostedCheckout(start);
    } catch {
      setBusy(false);
      setFormError({
        message: CHECKOUT_COPY.paymentOpenFailed,
        link: { href: start.statusUrl, label: CHECKOUT_COPY.goToOrder(start.orderId) },
      });
      setFocusTarget({ id: FORM_ERROR_ID, tick: Date.now() });
    }
  }

  function removeLine(key: string) {
    cart.remove(key);
    window.requestAnimationFrame(() => document.getElementById(ORDER_SUMMARY_HEADING_ID)?.focus());
  }

  if (!cart.ready) return <CheckoutSkeleton />;
  if (items.length === 0) return <EmptyCheckout />;

  return (
    <form noValidate onSubmit={onSubmit} className={GRID_CLASS}>
      <div className={MAIN_CLASS}>
        {formError ? (
          <div id={FORM_ERROR_ID} role="alert" tabIndex={-1} className={ALERT_CLASS}>
            <Icon name="error" size={20} className="mt-0.5" />
            <FormErrorBody error={formError} email={values.email} />
          </div>
        ) : null}
        {showFieldSummary(summary.length, formError) ? (
          // Prototype summary: one line; each field carries its own message (aria-invalid + aria-describedby).
          <div id={SUMMARY_ID} role="alert" tabIndex={-1} className={ALERT_CLASS}>
            <Icon name="error" size={20} className="mt-0.5" />
            <span>{CHECKOUT_COPY.fixFields}</span>
          </div>
        ) : null}
        <AccountSection viewer={viewer} onSignOut={signOut} signingOut={signingOut} headingRef={accountHeadingRef} />
        <ContactSection values={values} errors={errors} onChange={setValue} guest={guest} />
        <BillingSection values={values} errors={errors} onChange={setValue} />
        <TermsField checked={values.agree} error={errors.agree} onChange={(checked) => setValue("agree", checked)} />
      </div>
      <OrderSummary
        rows={rows}
        quote={quote.data}
        current={quote.current}
        quoteError={quote.error?.message ?? null}
        onRetryQuote={quote.retry}
        state={values.state}
        companyState={quote.data?.companyState ?? companyState}
        coupon={couponView}
        onCouponInput={onCouponInput}
        onApplyCoupon={() => void applyCoupon()}
        onRemoveCoupon={removeCoupon}
        showSampleCodes={showSampleCodes}
        onRemoveLine={removeLine}
        busy={busy}
        couponInputRef={couponInputRef}
        couponRemoveRef={couponRemoveRef}
      />
    </form>
  );
}

/** Message and optional link of the form error ("… Sign in instead." inline, "Go to order …" below). */
function FormErrorBody({ error, email }: { error: FormError; email: string }) {
  const { link } = error;
  if (!link) return <span>{error.message}</span>;
  const anchor = (
    <Link
      href={link.href}
      className={link.inline ? ALERT_LINK_CLASS : `justify-self-start ${ALERT_LINK_CLASS}`}
      onClick={link.handOffEmail ? () => saveSignInPrefill(email) : undefined}
    >
      {link.label}
    </Link>
  );
  if (link.inline) {
    return (
      <span>
        {error.message} {anchor}
      </span>
    );
  }
  return (
    <div className="grid gap-1">
      <span>{error.message}</span>
      {anchor}
    </div>
  );
}
