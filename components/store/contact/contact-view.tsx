"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Alert } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { FormErrorSummary, type FormError } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { CONTACT_COPY, CONTACT_MODE_ORDER, CONTACT_MODES, formatDayMonth, type ContactMode } from "@/content/contact";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { createLeadRequestSchema, leadFieldErrors, LEAD_SLOT_LABELS } from "@/lib/validation/lead";
import { ContactFields } from "./contact-fields";
import {
  CONTACT_FIELD_ORDER,
  contactFieldId,
  initialContactValues,
  toLeadRequestBody,
  type ContactFieldKey,
  type ContactFormValues,
  type DemoProductOption,
} from "./contact-form-model";

const SUMMARY_ID = "contact-error-summary";

type Sent = { mode: ContactMode; reference: string; phone: string; date: string; slot: string; email: string };

export type ContactViewProps = {
  /** From the URL on the server: ?type=demo or ?product=<slug> -> "demo". "#demo" is applied after hydration. */
  initialMode: ContactMode;
  /** Preselected product: a demo-enabled slug, "not-sure" or "". */
  initialProduct: string;
  /** PUBLISHED products with demo requests enabled, by rank. */
  products: readonly DemoProductOption[];
  /** Preferred date bounds (IST calendar dates) for the date input. */
  dateMin: string;
  dateMax: string;
  /** Stored with the lead, e.g. "product:medical-billing". */
  source: string | null;
  /** Right column (server-rendered): demo steps and contact details. */
  aside: React.ReactNode;
};

function isHashMode(hash: string): ContactMode | null {
  if (hash === "#demo") return "demo";
  if (hash === "#contact") return "contact";
  return null;
}

/** The URL for a mode: /contact?type=demo (the canonical demo link) or /contact. */
function urlForMode(mode: ContactMode): string {
  const url = new URL(window.location.href);
  url.hash = "";
  if (mode === "demo") {
    url.searchParams.set("type", "demo");
  } else {
    url.searchParams.delete("type");
    url.searchParams.delete("product");
  }
  return `${url.pathname}${url.search}`;
}

function serverFieldErrors(error: ApiClientError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(error.fieldErrors)) {
    const first = messages[0];
    if (first) out[key] = first;
  }
  return out;
}

/**
 * /contact body (Contact.dc.html): breadcrumb, title and lede for the mode, the "Form type" switch, then the form or
 * the success panel, with the aside on the right. Validation runs the same schema as POST /api/contact; errors appear
 * after the first submit and then update live. Values survive mode switches; "Send another" clears the message only.
 */
export function ContactView({ initialMode, initialProduct, products, dateMin, dateMax, source, aside }: ContactViewProps) {
  const [mode, setMode] = React.useState<ContactMode>(initialMode);
  const [values, setValues] = React.useState<ContactFormValues>(() => initialContactValues(initialProduct));
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState<Sent | null>(null);
  const [focusTarget, setFocusTarget] = React.useState<{ id: string; tick: number } | null>(null);
  const successHeadingRef = React.useRef<HTMLHeadingElement>(null);

  const schema = React.useMemo(
    () => createLeadRequestSchema({ demoProductIds: products.map((p) => p.id) }),
    [products],
  );
  const copy = CONTACT_MODES[mode];

  const switchMode = React.useCallback((next: ContactMode, updateUrl: boolean) => {
    if (updateUrl) window.history.replaceState(null, "", urlForMode(next));
    setMode(next);
    setSent(null);
    setTried(false);
    setServerErrors({});
    setFormError(null);
  }, []);

  // "#demo" / "#contact" (older links and the prototype's tabs). Other hashes, such as the skip link's #main, are ignored.
  React.useEffect(() => {
    const apply = () => {
      const hashMode = isHashMode(window.location.hash);
      if (hashMode) switchMode(hashMode, false);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [switchMode]);

  React.useEffect(() => {
    if (!focusTarget) return;
    const el = document.getElementById(focusTarget.id);
    el?.focus();
  }, [focusTarget]);

  React.useEffect(() => {
    if (sent) successHeadingRef.current?.focus();
  }, [sent]);

  const clientErrors = React.useMemo(() => {
    if (!tried) return {};
    const parsed = schema.safeParse(toLeadRequestBody(mode, values, source));
    return parsed.success ? {} : leadFieldErrors(parsed.error);
  }, [tried, schema, mode, values, source]);

  const fieldKeys = CONTACT_FIELD_ORDER[mode];
  const errors: Partial<Record<ContactFieldKey, string>> = {};
  for (const key of fieldKeys) {
    const message = clientErrors[key] ?? serverErrors[key];
    if (message) errors[key] = message;
  }
  const summary = fieldKeys.flatMap((key) => {
    const message = errors[key];
    return message ? [{ fieldId: contactFieldId(key), message }] : [];
  });

  const setValue = React.useCallback(<K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const body = toLeadRequestBody(mode, values, source);
    if (!schema.safeParse(body).success) {
      setTried(true);
      setServerErrors({});
      setFormError(null);
      setFocusTarget({ id: SUMMARY_ID, tick: Date.now() });
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const { reference } = await apiFetch<{ reference: string }>("/api/contact", { method: "POST", body });
      setSent({
        mode,
        reference,
        phone: values.phone.trim(),
        date: values.preferredDate,
        slot: LEAD_SLOT_LABELS[values.preferredSlot],
        email: values.email.trim(),
      });
      setTried(false);
      setServerErrors({});
    } catch (error) {
      if (error instanceof ApiClientError) {
        const fieldErrors = serverFieldErrors(error);
        const known = Object.keys(fieldErrors).some((key) => (fieldKeys as readonly string[]).includes(key));
        if (error.status === 422 && known) {
          setServerErrors(fieldErrors);
          setTried(true);
          setFocusTarget({ id: SUMMARY_ID, tick: Date.now() });
        } else {
          setFormError(error.message);
        }
      } else if (!(error instanceof DOMException && error.name === "AbortError")) {
        setFormError(UNEXPECTED_ERROR_MESSAGE);
      }
    } finally {
      setBusy(false);
    }
  }

  function sendAnother() {
    setSent(null);
    setTried(false);
    setServerErrors({});
    setValues((prev) => ({ ...prev, message: "" }));
    setFocusTarget({ id: contactFieldId("name"), tick: Date.now() });
  }

  return (
    <>
      <Breadcrumb>
        <BreadcrumbList className="gap-x-2">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">{CONTACT_COPY.breadcrumbHome}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-ink-2" />
          <BreadcrumbItem>
            <BreadcrumbPage>{copy.crumb}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* minmax(0,1fr): one column never grows past the page on phones (long addresses, larger text spacing). */}
      <div className="mt-[22px] grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <h1 className="m-0 text-[clamp(30px,3.8vw,44px)] font-extrabold leading-[normal] tracking-[-0.035em]">
            {copy.title}
          </h1>
          <p className="mb-0 mt-2.5 max-w-[620px] text-[16.5px] leading-[1.6] text-ink-2">{copy.lede}</p>
          <SegmentedControl
            aria-label={CONTACT_COPY.modeGroupLabel}
            options={CONTACT_MODE_ORDER.map((m) => ({ value: m, label: CONTACT_MODES[m].tab }))}
            value={mode}
            onValueChange={(next) => switchMode(next, true)}
            className="mt-5 gap-0 rounded-13 [&>button]:rounded-10 [&>button]:px-4 [&>button]:py-2.5 [&>button]:text-[14.5px] [&>button]:leading-[normal]"
          />

          {sent ? (
            <div role="status" className="mt-5 rounded-22 border border-sage-line bg-sage-bg p-7">
              <span aria-hidden="true" className="grid size-[52px] place-items-center rounded-[15px] bg-surface text-sage-fg">
                <Icon name="check_circle" size={28} />
              </span>
              <h2 ref={successHeadingRef} tabIndex={-1} className="mb-0 mt-3.5 text-[22px] font-extrabold leading-[normal]">
                {CONTACT_MODES[sent.mode].sentTitle}
              </h2>
              <p className="mb-0 mt-2 text-[15.5px] leading-[1.6] text-ink-soft">
                {sent.mode === "demo"
                  ? CONTACT_COPY.demoSentBody(sent.phone, formatDayMonth(sent.date), sent.slot)
                  : CONTACT_COPY.contactSentBody(sent.email)}
              </p>
              <p className="mb-0 mt-1.5 text-[13.5px] font-semibold text-ink-2">{CONTACT_COPY.reference(sent.reference)}</p>
              <Button type="button" variant="secondary" onClick={sendAnother} className="mt-4 text-base leading-[normal]">
                {CONTACT_COPY.sendAnother}
              </Button>
            </div>
          ) : (
            <form
              noValidate
              onSubmit={onSubmit}
              className="relative mt-5 grid gap-4 rounded-22 border border-line bg-surface p-6"
            >
              {formError ? <Alert tone="danger">{formError}</Alert> : null}
              <FormErrorSummaryLive id={SUMMARY_ID} errors={summary} />
              <ContactFields
                mode={mode}
                values={values}
                errors={errors}
                products={products}
                dateMin={dateMin}
                dateMax={dateMax}
                onChange={setValue}
              />
              <Button
                type="submit"
                size="lg"
                loading={busy}
                loadingText={CONTACT_COPY.sending}
                // Busy keeps the solid button (prototype); aria-busy still sets the progress cursor.
                className="justify-self-start gap-2.5 py-3.5 text-[15.5px] font-extrabold leading-[normal] shadow-none aria-disabled:opacity-100"
              >
                {copy.cta}
              </Button>
            </form>
          )}
        </div>
        <aside className="grid gap-3.5 md:max-lg:grid-cols-2">{aside}</aside>
      </div>
    </>
  );
}

/** The shared summary, without its focus-on-change (errors update live while typing; focus moves on submit only). */
function FormErrorSummaryLive({ id, errors }: { id: string; errors: readonly FormError[] }) {
  // text-[14.5px]: the prototype's summary line is 14.5px/700; the linked list keeps its own 14px.
  return <FormErrorSummary id={id} errors={errors} focusOnMount={false} className="rounded-12 px-3.5 py-3 text-[14.5px]" />;
}
