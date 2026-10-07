"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { usePortal } from "@/components/account/portal-context";
import { PORTAL_PATHS, ticketPath } from "@/components/account/portal-nav";
import { AttachButton, AttachmentChips, AttachmentMessages } from "@/components/account/tickets/attachments";
import { TICKET_CONTROL, TICKET_TEXTAREA, TicketField } from "@/components/account/tickets/form-parts";
import {
  emptyNewTicket,
  IMPACT_OPTIONS,
  initialTicketTarget,
  licenseOptionsFor,
  NEW_TICKET_FIELD_IDS,
  newTicketErrorsFromApi,
  newTicketSummary,
  ticketCreatedToast,
  TICKETS_COPY,
  validateNewTicket,
  type NewTicketErrors,
  type NewTicketField,
  type NewTicketLicense,
  type NewTicketProduct,
  type NewTicketValues,
} from "@/components/account/tickets/model";
import { useAttachments } from "@/components/account/tickets/use-attachments";
import { Button } from "@/components/ui/button";
import { FieldError, FormErrorSummary } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import type { TicketDetail } from "@/lib/portal/tickets";
import { cn } from "@/lib/utils";
import type { TicketImpact } from "@/lib/validation/tickets";

export type NewTicketFormProps = {
  products: readonly NewTicketProduct[];
  licenses: readonly NewTicketLicense[];
  /** ?product= / ?license= from the URL (e.g. "Get help" on a license). */
  prefill?: { product?: string | null; license?: string | null };
};

/**
 * "New support ticket" (prototype): Product and "Related license (optional)", Subject, Impact radio cards (Low /
 * Normal / High), "Describe the problem", "Attach screenshots" (presigned uploads), Submit ticket / Cancel. Errors
 * show inline and in a summary at the top after the first submit, and update as the fields change. A created
 * ticket opens its page with the toast "Ticket {id} created".
 */
export function NewTicketForm({ products, licenses, prefill }: NewTicketFormProps) {
  const router = useRouter();
  const { counts, updateCounts } = usePortal();
  const attachments = useAttachments();
  const [values, setValues] = React.useState<NewTicketValues>(() => emptyNewTicket(initialTicketTarget(products, licenses, prefill)));
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<NewTicketErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const formErrorRef = React.useRef<HTMLDivElement>(null);

  const licenseOptions = React.useMemo(() => licenseOptionsFor(licenses, values.productId), [licenses, values.productId]);
  const clientErrors = tried ? (() => {
    const result = validateNewTicket(values, attachments.readyIds);
    return result.ok ? {} : result.errors;
  })() : {};
  const blocker = tried ? attachments.blocker : null;
  const errors: NewTicketErrors = { ...serverErrors, ...clientErrors, ...(blocker ? { attachmentIds: blocker } : {}) };
  const summary = tried ? newTicketSummary(errors) : [];

  function set<K extends keyof NewTicketValues>(key: K, value: NewTicketValues[K]) {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      // A license of another product cannot stay selected.
      if (key === "productId" && !licenses.some((l) => l.id === prev.licenseId && l.productId === value)) next.licenseId = "";
      return next;
    });
    setServerErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key as NewTicketField];
      return next;
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setTried(true);
    setFormError(null);
    const result = validateNewTicket(values, attachments.readyIds);
    if (!result.ok || attachments.blocker) return;
    setSubmitting(true);
    try {
      const detail = await apiFetch<TicketDetail>("/api/account/tickets", { method: "POST", body: result.data });
      attachments.reset();
      updateCounts({ tickets: counts.tickets + 1 });
      toast.success(ticketCreatedToast(detail.ticket.id));
      router.push(ticketPath(detail.ticket.id));
    } catch (error) {
      setSubmitting(false);
      if (error instanceof ApiClientError && error.status === 422) {
        const mapped = newTicketErrorsFromApi(error.fieldErrors);
        if (Object.keys(mapped).length > 0) {
          setServerErrors(mapped);
          return;
        }
      }
      setFormError(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
      window.requestAnimationFrame(() => formErrorRef.current?.focus());
    }
  }

  if (products.length === 0) {
    return <p className="m-0 max-w-[760px] rounded-16 border border-line-alt bg-surface p-[18px] text-[14.5px] text-ink-2">{TICKETS_COPY.noProducts}</p>;
  }

  const attachErrorId = `${NEW_TICKET_FIELD_IDS.attachmentIds}-messages`;
  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-label={TICKETS_COPY.newTitle}
      className="grid max-w-[760px] gap-3.5 rounded-16 border border-line-alt bg-surface p-[18px] motion-safe:animate-enter-up"
    >
      {summary.length > 0 ? <FormErrorSummary errors={summary} /> : null}
      {formError ? (
        <div ref={formErrorRef} role="alert" tabIndex={-1} className="flex gap-2.5 rounded-14 bg-pink-bg px-[18px] py-3.5 text-[14px] font-bold text-danger">
          {formError}
        </div>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3.5">
        <TicketField id={NEW_TICKET_FIELD_IDS.productId} label={TICKETS_COPY.product} error={errors.productId}>
          {(control) => (
            <NativeSelect {...control} value={values.productId} onChange={(e) => set("productId", e.target.value)} className={TICKET_CONTROL}>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </TicketField>
        <TicketField id={NEW_TICKET_FIELD_IDS.licenseId} label={TICKETS_COPY.relatedLicense} error={errors.licenseId}>
          {(control) => (
            <NativeSelect {...control} value={values.licenseId} onChange={(e) => set("licenseId", e.target.value)} className={TICKET_CONTROL}>
              <option value="">{TICKETS_COPY.noLicense}</option>
              {licenseOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </TicketField>
      </div>
      <TicketField id={NEW_TICKET_FIELD_IDS.subject} label={TICKETS_COPY.subject} error={errors.subject}>
        {(control) => (
          <Input
            {...control}
            value={values.subject}
            onChange={(e) => set("subject", e.target.value)}
            placeholder={TICKETS_COPY.subjectPlaceholder}
            autoComplete="off"
            maxLength={200}
            className={TICKET_CONTROL}
          />
        )}
      </TicketField>
      <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={errors.impact ? "ticket-impact-error" : undefined}>
        <legend className="mb-1.5 p-0 text-[13px] font-bold text-ink">{TICKETS_COPY.impact}</legend>
        <div className="flex flex-wrap gap-2">
          {IMPACT_OPTIONS.map((option) => {
            const checked = values.impact === option.value;
            const id = `ticket-impact-${option.value}`;
            return (
              <label
                key={option.value}
                htmlFor={id}
                className={cn(
                  "grid flex-[1_1_180px] cursor-pointer grid-cols-[auto_minmax(0,1fr)] content-start items-start gap-x-2 rounded-10 border px-3 py-[9px] text-[13px] transition-colors",
                  checked ? "border-primary bg-lavender-soft" : "border-line-strong bg-surface hover:border-primary-accent",
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name="impact"
                  value={option.value}
                  checked={checked}
                  onChange={() => set("impact", option.value as TicketImpact)}
                  className="row-span-2 mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
                />
                <span className="font-extrabold">{option.label}</span>
                <span className="font-semibold text-ink-2">{option.hint}</span>
              </label>
            );
          })}
        </div>
        {errors.impact ? (
          <FieldError id="ticket-impact-error" className="mt-1.5">
            {errors.impact}
          </FieldError>
        ) : null}
      </fieldset>
      <TicketField id={NEW_TICKET_FIELD_IDS.body} label={TICKETS_COPY.describe} error={errors.body}>
        {(control) => (
          <Textarea
            {...control}
            rows={6}
            value={values.body}
            onChange={(e) => set("body", e.target.value)}
            placeholder={TICKETS_COPY.describePlaceholder}
            className={TICKET_TEXTAREA}
          />
        )}
      </TicketField>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <AttachButton
            id={NEW_TICKET_FIELD_IDS.attachmentIds}
            label={TICKETS_COPY.attachScreenshots}
            controller={attachments}
            describedBy={`${attachErrorId} ticket-attach-note`}
            invalid={!!errors.attachmentIds}
          />
          <AttachmentChips controller={attachments} />
        </div>
        <AttachmentMessages controller={attachments} id={attachErrorId} extra={errors.attachmentIds ?? null} />
        <p id="ticket-attach-note" className="m-0 text-[12px] text-ink-2">
          {TICKETS_COPY.attachNote}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line-subtle pt-1">
        <Button type="submit" loading={submitting} loadingText={TICKETS_COPY.submitting} className="mt-2.5 rounded-10 px-4 py-[9px] text-[15px]">
          {TICKETS_COPY.submit}
        </Button>
        <Link
          href={PORTAL_PATHS.tickets}
          className="mt-2.5 inline-flex items-center rounded-10 border border-line-input bg-surface px-4 py-[9px] text-[15px] font-bold leading-tight text-ink no-underline transition-colors hover:border-primary hover:text-ink"
        >
          {TICKETS_COPY.cancel}
        </Link>
      </div>
    </form>
  );
}
