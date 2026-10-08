"use client";

import * as React from "react";
import { useCan } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { DrawerSubmit, type AdminDrawerEdit } from "@/components/admin/drawer";
import { formErrorsFrom, NO_ERRORS, type FormErrors } from "@/components/admin/coupons/form-errors";
import { Alert } from "@/components/ui/alert";
import {
  CUSTOMER_RECORD_COPY as COPY,
  customerDraftErrors,
  customerEditDraft,
  customerEditPatch,
  draftChangesEmail,
  type AdminCustomerDetail,
} from "@/lib/admin/customers/model";
import { apiFetch } from "@/lib/client/api";
import { requiresLabel } from "@/lib/rbac";
import { CheckboxField, CustomerErrorSummary, CustomerFields, fieldId, FormAlert, ReasonField, type CustomerDraft } from "./customer-form";

type Props = {
  customer: AdminCustomerDetail;
  /** After a save that changed something: reload the drawer and the list. */
  onSaved: () => void;
};

/**
 * The drawer's "Edit details" form (customers.edit): the owner's name, email and mobile (they belong to the person and
 * change in every account they are in) and the business details. Sends only the changed fields with a reason. An
 * email change shows the sign-out warning and "New email already verified" (customers.verify_email).
 */
function CustomerEditForm({ customer, onSaved }: Props) {
  const canVerify = useCan("customers.verify_email");
  const prefix = `customer-edit-${customer.id}`;
  const [draft, setDraft] = React.useState<CustomerDraft>(() => customerEditDraft(customer));
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = React.useState(false);

  // Another customer, or fresh data after a save: the form starts again from the stored values.
  const stored = JSON.stringify([customer.id, customer.legalName, customer.gstin, customer.address, customer.city, customer.state, customer.pin, customer.owner?.userId, customer.owner?.name, customer.owner?.email, customer.owner?.phone]);
  const [formFor, setFormFor] = React.useState(stored);
  if (formFor !== stored) {
    setFormFor(stored);
    setDraft(customerEditDraft(customer));
    setErrors(NO_ERRORS);
  }

  const owner = customer.owner;
  const emailChanging = draftChangesEmail(customer, draft);

  async function save() {
    if (busy) return;
    const patch = customerEditPatch(customer, draft);
    if (Object.keys(patch).length === 0) {
      setErrors(NO_ERRORS);
      adminToast.success(COPY.noChanges);
      return;
    }
    const local = customerDraftErrors(draft, "edit");
    if (Object.keys(local).length > 0) return setErrors({ fields: local, form: null });
    setBusy(true);
    try {
      const result = await apiFetch<{ changed: boolean; signedOut: number }>(`/api/admin/customers/${encodeURIComponent(customer.id)}`, {
        method: "PATCH",
        body: { ...patch, reason: draft.reason.trim() },
      });
      setErrors(NO_ERRORS);
      if (!result.changed) {
        adminToast.success(COPY.noChanges);
        return;
      }
      adminToast.success(result.signedOut > 0 ? COPY.updatedSignedOut(result.signedOut) : COPY.updated);
      setDraft((d) => ({ ...d, reason: "", emailVerified: false }));
      onSaved();
    } catch (error) {
      setErrors(formErrorsFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <CustomerErrorSummary prefix={prefix} fields={errors.fields} />
      <FormAlert>{errors.form}</FormAlert>
      {owner ? null : <p className="m-0 text-[12.5px] text-ink-2">{COPY.noOwnerNote}</p>}
      <CustomerFields
        prefix={prefix}
        draft={draft}
        onChange={setDraft}
        errors={errors.fields}
        person={owner !== null}
        personNote={COPY.personNote}
        legalNameLabel={COPY.legalNameEdit}
        afterEmail={
          emailChanging && owner ? (
            <>
              <CheckboxField
                id={fieldId(prefix, "emailVerified")}
                label={COPY.newEmailVerified}
                hint={canVerify ? undefined : requiresLabel("customers.verify_email")}
                error={errors.fields.emailVerified}
                checked={draft.emailVerified}
                disabled={!canVerify}
                onChange={(checked) => setDraft({ ...draft, emailVerified: checked })}
              />
              <Alert tone="warning" role="note" className="px-3 py-2.5 text-[13px]">
                {COPY.emailChangeWarning(owner.name || owner.email)}
              </Alert>
            </>
          ) : null
        }
      />
      <ReasonField prefix={prefix} value={draft.reason} error={errors.fields.reason} onChange={(reason) => setDraft({ ...draft, reason })} />
      <DrawerSubmit loading={busy}>{COPY.save}</DrawerSubmit>
    </form>
  );
}

/** The drawer's edit slot: read only (with the note) for roles without customers.edit. */
export function useCustomerEdit(customer: AdminCustomerDetail | null, onSaved: () => void): AdminDrawerEdit | undefined {
  const canEdit = useCan("customers.edit");
  if (!customer) return undefined;
  return {
    title: COPY.editTitle,
    readOnly: !canEdit,
    readOnlyNote: COPY.editReadOnly,
    form: <CustomerEditForm key={customer.id} customer={customer} onSaved={onSaved} />,
  };
}
