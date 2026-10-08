"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { adminToast } from "@/components/admin/admin-toaster";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { Field, FieldError, FormErrorSummary, type FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { ItemKind } from "@/generated/prisma/enums";
import type { AdminCustomerDetail, AdminCustomerLicense } from "@/lib/admin/customers/model";
import { ORDER_QUOTE_PATH } from "@/lib/admin/orders/model";
import {
  emptyLine,
  ITEM_KIND_LABELS,
  kindsForPlanType,
  lineHasQuantity,
  lineMaxQty,
  lineNeedsTarget,
  ORDER_RECORD_COPY as COPY,
  ORDER_RECORD_MESSAGES,
  orderItemsPayload,
  type AdminOrderPlanOption,
  type OrderBillingDraft,
  type OrderLineDraft,
} from "@/lib/admin/orders/records-model";
import type { QuoteDto } from "@/lib/checkout/quote";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { formatDateIST } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { INDIAN_STATES } from "@/lib/validation/states";

const money = (paise: number) => formatINR(paise, { exact: true });
const twoColumns = "grid gap-2.5 min-[26.25rem]:grid-cols-2";

/** DOM id of a form field: "order-new-billing-name", "order-new-items-0-planId". */
export const orderFieldId = (prefix: string, key: string) => `${prefix}-${key.replace(/\./g, "-")}`;

/** Field order of the error summary. */
const SUMMARY_ORDER = [
  "accountId",
  "items",
  "couponCode",
  "billing.name",
  "billing.email",
  "billing.phone",
  "billing.business",
  "billing.gstin",
  "billing.address",
  "billing.city",
  "billing.state",
  "billing.pin",
  "method",
  "reference",
  "receivedOn",
  "amountPaise",
  "reason",
];

/** "Please fix …" entries (each links to and focuses its field), item fields in line order. */
export function orderSummaryErrors(prefix: string, fields: Record<string, string>): FormError[] {
  const rank = (key: string) => {
    const i = SUMMARY_ORDER.indexOf(key.startsWith("items.") ? "items" : key);
    return i < 0 ? SUMMARY_ORDER.length : i;
  };
  return Object.entries(fields)
    .filter(([key]) => key !== "_form")
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, message]) => ({ fieldId: orderFieldId(prefix, key === "items" ? "items.add" : key), message }));
}

/** Server refusals as field errors: validation fieldErrors, cart_invalid issues (per line) and form messages. */
export function orderErrorsFrom(error: unknown): { fields: Record<string, string>; form: string | null } {
  if (!(error instanceof ApiClientError)) return { fields: {}, form: error instanceof Error ? error.message : "Something went wrong. Try again." };
  const fields: Record<string, string> = {};
  for (const [key, messages] of Object.entries(error.fieldErrors)) if (messages[0]) fields[key] = messages[0];
  const issues = Array.isArray(error.details.issues) ? (error.details.issues as Array<{ index?: unknown; message?: unknown }>) : [];
  for (const issue of issues) {
    if (typeof issue.index === "number" && typeof issue.message === "string") fields[`items.${issue.index}.planId`] ??= issue.message;
  }
  const raw = error.details.formErrors;
  const formMessages = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
  const form = formMessages[0] ?? (Object.keys(fields).length === 0 || issues.length > 0 ? error.message : null);
  return { fields, form };
}

/** Form-level refusal (rate limit, permission, conflict without a field). Announced, not focused. */
export function OrderFormAlert({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="m-0 rounded-8 bg-pink-bg px-2.5 py-2 text-[13px] font-bold text-danger">
      {children}
    </p>
  );
}

export function OrderErrorSummary({ prefix, fields }: { prefix: string; fields: Record<string, string> }) {
  const errors = orderSummaryErrors(prefix, fields);
  if (errors.length === 0) return null;
  return <FormErrorSummary errors={errors} className="rounded-10 px-3 py-2.5 text-[13px] [&_li]:text-[13px]" />;
}

function Legend({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <legend className="mb-1.5 p-0">
      <span className="block text-[12.5px] font-extrabold text-ink">{children}</span>
      {hint ? <span className="block text-[12px] font-semibold text-ink-2">{hint}</span> : null}
    </legend>
  );
}

// ---------- Data hooks ----------

type CustomerLoad = { status: "idle" | "loading" | "error"; customer: AdminCustomerDetail | null };

/** GET /api/admin/customers/:id for the order form (prefill and target licenses). */
export function useCustomerDetail(accountId: string | null): CustomerLoad {
  const [state, setState] = React.useState<CustomerLoad>({ status: "idle", customer: null });
  React.useEffect(() => {
    if (!accountId) {
      setState({ status: "idle", customer: null });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ status: "loading", customer: s.customer?.id === accountId ? s.customer : null }));
    apiFetch<{ customer: AdminCustomerDetail }>(`/api/admin/customers/${encodeURIComponent(accountId)}`, { signal: controller.signal })
      .then(({ customer }) => setState({ status: "idle", customer }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error", customer: null });
      });
    return () => controller.abort();
  }, [accountId]);
  return state;
}

export type QuoteTarget = { accountId: string } | { orderId: string };

export type OrderQuoteState = { quote: QuoteDto | null; loading: boolean; error: boolean };

/**
 * The server quote (POST /api/admin/orders/quote), 300 ms after the last change; null until there is something to
 * price. A failed request clears the quote and sets `error`, so no stale total is shown or used as the amount hint.
 */
export function useOrderQuote(
  target: QuoteTarget | null,
  lines: readonly OrderLineDraft[],
  plans: readonly AdminOrderPlanOption[],
  couponCode: string,
  billingState: string,
): OrderQuoteState {
  const items = React.useMemo(() => orderItemsPayload(lines, plans), [lines, plans]);
  const key = JSON.stringify([target, items, couponCode.trim(), billingState]);
  const [state, setState] = React.useState<{ key: string } & OrderQuoteState>({ key: "", quote: null, loading: false, error: false });
  React.useEffect(() => {
    const [t, it, code, st] = JSON.parse(key) as [QuoteTarget | null, unknown[], string, string];
    if (!t || it.length === 0) {
      setState({ key, quote: null, loading: false, error: false });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = window.setTimeout(() => {
      apiFetch<{ quote: QuoteDto }>(ORDER_QUOTE_PATH, {
        method: "POST",
        body: { ...t, items: it, couponCode: code || null, billingState: st || null },
        signal: controller.signal,
      })
        .then(({ quote }) => setState({ key, quote, loading: false, error: false }))
        .catch(() => {
          if (!controller.signal.aborted) setState({ key, quote: null, loading: false, error: true });
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  return { quote: state.quote, loading: state.loading, error: state.error };
}

// ---------- Items ----------

type ItemsProps = {
  prefix: string;
  lines: OrderLineDraft[];
  onChange: (lines: OrderLineDraft[]) => void;
  plans: readonly AdminOrderPlanOption[];
  licenses: readonly AdminCustomerLicense[];
  errors: Record<string, string>;
  quote: QuoteDto | null;
  /** Names of plans no longer offered (an unpaid order being edited), by plan id. */
  legacyPlans?: Readonly<Record<string, string>>;
};

/** One row per line: plan, type, target license, quantity, remove; "Add item" below. Quote issues show under their row. */
export function OrderItemsEditor({ prefix, lines, onChange, plans, licenses, errors, quote, legacyPlans = {} }: ItemsProps) {
  const groups = React.useMemo(() => {
    const map = new Map<string, AdminOrderPlanOption[]>();
    for (const p of plans) map.set(p.productName, [...(map.get(p.productName) ?? []), p]);
    return [...map.entries()];
  }, [plans]);
  const byId = React.useMemo(() => new Map(plans.map((p) => [p.id, p])), [plans]);
  const issueAt = (index: number) => {
    // The quote reports issues by the request's item index (lines without a plan are not sent).
    const sent = lines.slice(0, index + 1).filter((l) => l.planId).length - 1;
    return lines[index]?.planId ? quote?.issues.find((i) => i.index === sent)?.message : undefined;
  };
  const update = (index: number, patch: Partial<OrderLineDraft>) => onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  return (
    <fieldset className="m-0 grid min-w-0 gap-2.5 border-0 p-0">
      <Legend>{COPY.items}</Legend>
      {lines.map((line, index) => {
        const plan = byId.get(line.planId);
        const n = index + 1;
        const kinds = plan ? kindsForPlanType(plan.type) : [];
        const needsTarget = plan ? lineNeedsTarget(line.kind, plan.type) : false;
        const productLicenses = plan ? licenses.filter((l) => l.productId === plan.productId) : [];
        const issue = issueAt(index);
        const issueId = `${orderFieldId(prefix, `items.${index}`)}-issue`;
        const key = (k: string) => `items.${index}.${k}`;
        return (
          <div key={line.key} className="grid gap-2 rounded-10 border border-line-subtle p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-extrabold text-ink-2">Item {n}</span>
              {lines.length > 1 ? (
                <AdminAction size="xs" icon="delete" aria-label={COPY.removeItem(n)} onClick={() => onChange(lines.filter((_, i) => i !== index))}>
                  <span className="sr-only">{COPY.removeItem(n)}</span>
                </AdminAction>
              ) : null}
            </div>
            <Field size="sm" label={COPY.plan} required error={errors[key("planId")]} id={orderFieldId(prefix, key("planId"))}>
              <NativeSelect
                size="sm"
                value={line.planId}
                placeholder={COPY.planPlaceholder}
                aria-describedby={issue ? issueId : undefined}
                onChange={(e) => {
                  const next = byId.get(e.target.value);
                  const allowed = next ? kindsForPlanType(next.type) : [];
                  update(index, {
                    planId: e.target.value,
                    kind: allowed.includes(line.kind) ? line.kind : (allowed[0] ?? line.kind),
                    targetLicenseId: "",
                    qty: "1",
                  });
                }}
              >
                {line.planId && !plan ? <option value={line.planId}>{legacyPlans[line.planId] ?? line.planId} (no longer sold)</option> : null}
                {groups.map(([product, items]) => (
                  <optgroup key={product} label={product}>
                    {items.map((p) => (
                      <option key={p.id} value={p.id}>
                        {`${p.planName} · ${money(p.pricePaise)}${p.perUnit ? ` per ${p.perUnit}` : ""}`}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </Field>
            {plan ? (
              <div className={twoColumns}>
                <Field size="sm" label={COPY.type} id={orderFieldId(prefix, key("kind"))} error={errors[key("kind")]}>
                  {(control) => (
                    <ChoiceSelect
                      {...control}
                      size="sm"
                      value={line.kind}
                      onValueChange={(value) => update(index, { kind: value as ItemKind, targetLicenseId: "" })}
                      options={kinds.map((k) => ({ value: k, label: ITEM_KIND_LABELS[k] }))}
                    />
                  )}
                </Field>
                {lineHasQuantity(plan, line.kind) ? (
                  <Field size="sm" label={COPY.quantity} error={errors[key("qty")]} id={orderFieldId(prefix, key("qty"))}>
                    <Input
                      size="sm"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={lineMaxQty(plan)}
                      value={line.qty}
                      onChange={(e) => update(index, { qty: e.target.value })}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}
            {plan && needsTarget ? (
              <Field
                size="sm"
                label={COPY.forLicense}
                required
                hint={productLicenses.length === 0 ? COPY.noLicenses : undefined}
                error={errors[key("targetLicenseId")]}
                id={orderFieldId(prefix, key("targetLicenseId"))}
              >
                <NativeSelect size="sm" value={line.targetLicenseId} placeholder={COPY.licensePlaceholder} onChange={(e) => update(index, { targetLicenseId: e.target.value })}>
                  {productLicenses.map((l) => (
                    <option key={l.id} value={l.id}>
                      {`${l.id} · ${l.planName} · ${l.status}`}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            {issue ? (
              <p id={issueId} role="alert" className="m-0 text-[13px] font-semibold text-danger">
                {issue}
              </p>
            ) : null}
          </div>
        );
      })}
      {errors.items ? <FieldError id={`${orderFieldId(prefix, "items.add")}-error`}>{errors.items}</FieldError> : null}
      <div>
        <AdminAction
          size="sm"
          icon="add"
          id={orderFieldId(prefix, "items.add")}
          aria-describedby={errors.items ? `${orderFieldId(prefix, "items.add")}-error` : undefined}
          onClick={() => onChange([...lines, emptyLine()])}
        >
          {COPY.addItem}
        </AdminAction>
      </div>
    </fieldset>
  );
}

// ---------- Coupon ----------

export function CouponField({
  prefix,
  value,
  onChange,
  error,
  quote,
}: {
  prefix: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  quote: QuoteDto | null;
}) {
  const result = value.trim() && quote?.coupon && quote.coupon.code === value.trim().toUpperCase() ? quote.coupon : null;
  const quoteError = result && !result.ok ? result.message : undefined;
  const hint = result && result.ok ? `${result.label} · −${money(result.discountPaise)}` : COPY.couponHint;
  return (
    <Field size="sm" label={COPY.coupon} optional hint={hint} error={error ?? quoteError} id={orderFieldId(prefix, "couponCode")}>
      <Input size="sm" mono autoComplete="off" spellCheck={false} maxLength={40} value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
    </Field>
  );
}

// ---------- Billing ----------

type BillingProps = {
  prefix: string;
  billing: OrderBillingDraft;
  onChange: (billing: OrderBillingDraft) => void;
  errors: Record<string, string>;
  /** Paid-order corrections: state and email are shown read only. */
  locked?: boolean;
};

/** Billing details (checkout's fields and messages), "Printed on the tax invoice." */
export function OrderBillingFields({ prefix, billing, onChange, errors, locked = false }: BillingProps) {
  const set = (key: keyof OrderBillingDraft, value: string) => onChange({ ...billing, [key]: value });
  const id = (key: string) => orderFieldId(prefix, `billing.${key}`);
  const err = (key: string) => errors[`billing.${key}`];
  return (
    <fieldset className="m-0 grid min-w-0 gap-2.5 border-0 p-0">
      <Legend hint={COPY.billingHint}>{COPY.billing}</Legend>
      <div className={twoColumns}>
        <Field size="sm" label={COPY.billingName} required error={err("name")} id={id("name")}>
          <Input size="sm" autoComplete="off" maxLength={100} value={billing.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field size="sm" label={COPY.billingPhone} required error={err("phone")} id={id("phone")}>
          <Input size="sm" type="tel" inputMode="tel" autoComplete="off" maxLength={20} value={billing.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
      </div>
      <Field size="sm" label={COPY.billingEmail} required error={err("email")} id={id("email")} hint={locked ? ORDER_RECORD_MESSAGES.emailLocked : undefined}>
        <Input
          size="sm"
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          maxLength={254}
          readOnly={locked}
          value={billing.email}
          onChange={(e) => set("email", e.target.value)}
        />
      </Field>
      <Field size="sm" label={COPY.billingBusiness} optional error={err("business")} id={id("business")}>
        <Input size="sm" autoComplete="off" maxLength={120} value={billing.business} onChange={(e) => set("business", e.target.value)} />
      </Field>
      <div className={twoColumns}>
        <Field size="sm" label={COPY.billingGstin} optional error={err("gstin")} id={id("gstin")}>
          <Input size="sm" mono autoComplete="off" spellCheck={false} maxLength={20} value={billing.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} />
        </Field>
        <Field size="sm" label={COPY.billingState} required error={err("state")} id={id("state")} hint={locked ? COPY.correctLockedHint : undefined}>
          {locked ? (
            <Input size="sm" readOnly value={billing.state} />
          ) : (
            <NativeSelect size="sm" value={billing.state} placeholder={COPY.billingStatePlaceholder} onChange={(e) => set("state", e.target.value)}>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <Field size="sm" label={COPY.billingAddress} required error={err("address")} id={id("address")}>
        <Input size="sm" autoComplete="off" maxLength={300} value={billing.address} onChange={(e) => set("address", e.target.value)} />
      </Field>
      <div className={twoColumns}>
        <Field size="sm" label={COPY.billingCity} required error={err("city")} id={id("city")}>
          <Input size="sm" autoComplete="off" maxLength={80} value={billing.city} onChange={(e) => set("city", e.target.value)} />
        </Field>
        <Field size="sm" label={COPY.billingPin} required error={err("pin")} id={id("pin")}>
          <Input size="sm" inputMode="numeric" autoComplete="off" maxLength={6} value={billing.pin} onChange={(e) => set("pin", e.target.value)} />
        </Field>
      </div>
    </fieldset>
  );
}

// ---------- Summary ----------

/**
 * The server quote's totals (aria-live): Subtotal, Discount, Taxable value, CGST/SGST or IGST, Total. Without a quote it
 * says what is missing (`emptyText`), or that pricing failed (`error`).
 */
export function OrderSummary({
  quote,
  loading,
  error = false,
  emptyText = COPY.summaryEmptyNew,
}: {
  quote: QuoteDto | null;
  loading: boolean;
  error?: boolean;
  emptyText?: string;
}) {
  const rows: Array<[string, string]> = quote
    ? [
        [COPY.subtotal, money(quote.subtotalPaise)],
        ...(quote.discountPaise > 0 ? ([[COPY.discount, `−${money(quote.discountPaise)}`]] as Array<[string, string]>) : []),
        [COPY.taxable, money(quote.taxablePaise)],
        ...((quote.intraState
          ? [
              [`CGST ${quote.gstRatePct / 2}%`, money(quote.cgstPaise)],
              [`SGST ${quote.gstRatePct / 2}%`, money(quote.sgstPaise)],
            ]
          : [[`IGST ${quote.gstRatePct}%`, money(quote.igstPaise)]]) as Array<[string, string]>),
      ]
    : [];
  return (
    <section aria-label={COPY.summary} className="grid gap-1.5 rounded-10 bg-bg px-3 py-2.5 text-[13px]">
      <div aria-live="polite" aria-atomic="true" className="grid gap-1">
        {loading ? <span className="font-semibold text-ink-2">{COPY.updating}</span> : null}
        {quote ? (
          <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-semibold text-ink-2">{label}</dt>
                <dd className="m-0 text-right font-semibold">{value}</dd>
              </div>
            ))}
            <dt className="font-extrabold">{COPY.total}</dt>
            <dd className="m-0 text-right font-extrabold">{money(quote.totalPaise)}</dd>
          </dl>
        ) : loading ? null : error ? (
          <span className="font-semibold text-danger">{COPY.quoteFailed}</span>
        ) : (
          <span className="text-ink-2">{emptyText}</span>
        )}
      </div>
      <p className="m-0 text-[12px] text-ink-2">{COPY.summaryNote}</p>
    </section>
  );
}

// ---------- Reason ----------

export function OrderReasonField({ prefix, value, error, onChange }: { prefix: string; value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <Field size="sm" label={COPY.reason} required error={error} id={orderFieldId(prefix, "reason")}>
      <Textarea size="sm" rows={2} maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

// ---------- One-time payment link panel ----------

export type PaymentLinkView = { url: string; expiresAt: string; email: string };

/**
 * The payment link with "Copy link" (the order link: no credential, but only the customer should get it). Takes focus
 * when it appears. Kept in component state only, never in the URL or storage.
 */
export function PaymentLinkPanel({ link, heading, actions, note = true }: { link: PaymentLinkView; heading?: string; actions?: React.ReactNode; note?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const inputId = React.useId();
  React.useEffect(() => {
    ref.current?.focus();
  }, []);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(link.url);
      adminToast.success(COPY.copied);
    } catch {
      adminToast.error(null, COPY.copyFailed);
    }
  }

  return (
    <Alert ref={ref} tabIndex={-1} data-link-panel="" tone="success" role="status" className="text-[13.5px] focus-visible:outline-2 focus-visible:outline-primary">
      {heading ? <AlertTitle className="text-[14px]">{heading}</AlertTitle> : null}
      <AlertDescription className="grid gap-2.5 text-[13px]">
        <Field size="sm" label={COPY.linkLabel} id={`${inputId}-link`}>
          <Input size="sm" mono readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} className="text-[12.5px]" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <AdminAction size="sm" icon="content_copy" onClick={copy}>
            {COPY.copyLink}
          </AdminAction>
        </div>
        {note ? <p className="m-0">{COPY.linkEmailed(link.email)}</p> : <p className="m-0">Works until {formatDateIST(new Date(link.expiresAt))}.</p>}
        <p className="m-0 font-bold">{COPY.linkNote}</p>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </AlertDescription>
    </Alert>
  );
}

export { emptyLine };
