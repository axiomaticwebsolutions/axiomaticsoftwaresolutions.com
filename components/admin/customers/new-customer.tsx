"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useCan } from "@/components/admin/admin-context";
import { AdminDrawer, DrawerSubmit } from "@/components/admin/drawer";
import { withParam } from "@/components/admin/model";
import { useDrawerParam } from "@/components/admin/use-drawer-param";
import { formErrorsFrom, NO_ERRORS, type FormErrors } from "@/components/admin/coupons/form-errors";
import {
  adminCustomerHref,
  CUSTOMER_RECORD_COPY as COPY,
  customerCreatePayload,
  customerDraftErrors,
  EMPTY_CUSTOMER_DRAFT,
} from "@/lib/admin/customers/model";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { requiresLabel } from "@/lib/rbac";
import { CheckboxField, CustomerErrorSummary, CustomerFields, fieldId, FormAlert, ReasonField, type CustomerDraft } from "./customer-form";
import { SetPasswordLinkPanel, type OneTimeLink } from "./set-password-link";

/** URL parameter of the "New customer" drawer (?new=1). */
export const NEW_CUSTOMER_PARAM = "new";

const PREFIX = "customer-new";

type Created = OneTimeLink & { accountId: string };

/** Header action "New customer" (customers.create): opens the create drawer. */
export function NewCustomerAction() {
  const create = useDrawerParam(NEW_CUSTOMER_PARAM);
  return (
    <AdminAction perm="customers.create" variant="primary" icon="person_add" onClick={() => create.open("1")} aria-haspopup="dialog">
      {COPY.newCustomer}
    </AdminAction>
  );
}

/**
 * "New customer" drawer (?new=1): the person, the business details, "Email already verified" (customers.verify_email)
 * and the reason. On success the form is replaced by the one-time set-password link panel, which takes focus; the link
 * is kept in this component's state only and dropped when the drawer closes or "Add another" starts again.
 */
export function NewCustomerDrawer({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const canCreate = useCan("customers.create");
  const canVerify = useCan("customers.verify_email");
  const [draft, setDraft] = React.useState<CustomerDraft>(EMPTY_CUSTOMER_DRAFT);
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [existingId, setExistingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [created, setCreated] = React.useState<Created | null>(null);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    // Opening starts a fresh form; closing forgets the one-time link.
    setDraft(EMPTY_CUSTOMER_DRAFT);
    setErrors(NO_ERRORS);
    setExistingId(null);
    setCreated(null);
  }

  async function submit() {
    if (busy) return;
    const local = customerDraftErrors(draft, "create");
    if (Object.keys(local).length > 0) {
      setExistingId(null);
      return setErrors({ fields: local, form: null });
    }
    setBusy(true);
    try {
      const result = await apiFetch<{ accountId: string; setPassword: { url: string; expiresAt: string }; emailSent: boolean }>("/api/admin/customers", {
        method: "POST",
        body: customerCreatePayload(draft),
      });
      setErrors(NO_ERRORS);
      setExistingId(null);
      setCreated({ accountId: result.accountId, url: result.setPassword.url, expiresAt: result.setPassword.expiresAt, emailSent: result.emailSent, name: draft.name.trim() });
      setDraft(EMPTY_CUSTOMER_DRAFT);
      onCreated?.();
    } catch (error) {
      setErrors(formErrorsFrom(error));
      const accountId = error instanceof ApiClientError && error.code === "email_taken" ? error.details.accountId : null;
      setExistingId(typeof accountId === "string" ? accountId : null);
    } finally {
      setBusy(false);
    }
  }

  function openCustomer(accountId: string) {
    const search = withParam(withParam(window.location.search, NEW_CUSTOMER_PARAM, null), "id", accountId);
    router.replace(`${pathname}${search}`, { scroll: false });
  }

  const form = (
    <form
      noValidate
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <CustomerErrorSummary prefix={PREFIX} fields={errors.fields} />
      <FormAlert>{errors.form}</FormAlert>
      <CustomerFields
        prefix={PREFIX}
        draft={draft}
        onChange={setDraft}
        errors={errors.fields}
        person
        legalNameLabel={COPY.legalName}
        legalNameHint={COPY.legalNameHint}
        afterEmail={
          <>
            {existingId ? (
              <p className="m-0 text-[13px]">
                <Link href={adminCustomerHref(existingId)} className="font-bold text-primary-link underline underline-offset-2" onClick={(e) => {
                  e.preventDefault();
                  openCustomer(existingId);
                }}>
                  {COPY.openCustomer}
                </Link>
              </p>
            ) : null}
            <CheckboxField
              id={fieldId(PREFIX, "emailVerified")}
              label={COPY.emailVerified}
              hint={canVerify ? COPY.emailVerifiedHint : requiresLabel("customers.verify_email")}
              error={errors.fields.emailVerified}
              checked={draft.emailVerified}
              disabled={!canVerify}
              onChange={(checked) => setDraft({ ...draft, emailVerified: checked })}
            />
          </>
        }
      />
      <ReasonField prefix={PREFIX} value={draft.reason} error={errors.fields.reason} onChange={(reason) => setDraft({ ...draft, reason })} />
      <DrawerSubmit loading={busy}>{COPY.create}</DrawerSubmit>
    </form>
  );

  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind="Customer"
      title={COPY.newCustomer}
      subtitle={COPY.newSubtitle}
      edit={created ? undefined : { title: COPY.details, readOnly: !canCreate, form }}
    >
      {created ? (
        <SetPasswordLinkPanel
          link={created}
          heading={COPY.created}
          actions={
            <>
              <AdminAction size="sm" variant="primary" icon="storefront" onClick={() => openCustomer(created.accountId)}>
                {COPY.openCustomer}
              </AdminAction>
              <AdminAction size="sm" icon="person_add" onClick={() => setCreated(null)}>
                {COPY.addAnother}
              </AdminAction>
            </>
          }
        />
      ) : null}
    </AdminDrawer>
  );
}
