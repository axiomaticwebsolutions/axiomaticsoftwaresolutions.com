"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { adminToast } from "@/components/admin/admin-toaster";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import type { StaffRole } from "@/generated/prisma/enums";
import { ROLE_SUMMARIES, STAFF_COPY, STAFF_ERRORS } from "@/lib/admin/staff/model";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { isStaffRole, STAFF_ROLE_LABELS, STAFF_ROLES } from "@/lib/rbac";
import { cn } from "@/lib/utils";

const DEFAULT_ROLE: StaffRole = "SUPPORT";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** POST /api/admin/staff and POST .../resend-invite: `emailSent` false when the invitation email could not be sent. */
export type StaffInviteResponse = { emailSent?: boolean };

/** New copy (owner review): the invitation exists, but its email failed (decisions.md Phase 6 build decisions). */
export const STAFF_INVITE_EMAIL_FAILED = "Invitation created, but the email couldn\u2019t be sent. Use Resend.";
/** A warning stays longer than the 3.4 s success toast: the Owner has to act on it. */
const WARNING_DURATION_MS = 10_000;

/** Success toast, or the warning when the API reports that the invitation email was not sent. */
export function toastInviteOutcome(result: StaffInviteResponse, success: string): void {
  if (result.emailSent === false) toast.warning(STAFF_INVITE_EMAIL_FAILED, { duration: WARNING_DURATION_MS });
  else adminToast.success(success);
}

/**
 * Header action "Invite staff" (prototype primary person_add button) and its dialog: work email + role (with what
 * each role can do), then POST /api/admin/staff. Owner only (staff.manage); other roles never reach the page.
 */
export function InviteStaffButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <AdminAction perm="staff.manage" variant="primary" icon="person_add" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {STAFF_COPY.invite}
      </AdminAction>
      <InviteStaffDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function InviteStaffDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-[480px] gap-0 p-5 leading-[normal] sm:p-5">
        {/* Content unmounts on close: the form starts empty every time. */}
        <InviteForm busy={busy} setBusy={setBusy} close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function InviteForm({ busy, setBusy, close }: { busy: boolean; setBusy: (busy: boolean) => void; close: () => void }) {
  const router = useRouter();
  const id = React.useId();
  const emailRef = React.useRef<HTMLInputElement>(null);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<StaffRole>(DEFAULT_ROLE);
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const focusEmail = () => window.requestAnimationFrame(() => emailRef.current?.focus());

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    setError(null);
    if (!EMAIL_RE.test(address) || address.length > 254) {
      setEmailError(STAFF_ERRORS.email);
      focusEmail();
      return;
    }
    setEmailError(null);
    setBusy(true);
    try {
      const result = await apiFetch<StaffInviteResponse>("/api/admin/staff", { method: "POST", body: { email: address, role } });
      setBusy(false);
      close();
      toastInviteOutcome(result, STAFF_COPY.invited(address));
      router.refresh();
    } catch (cause) {
      setBusy(false);
      if (!(cause instanceof ApiClientError)) return setError(UNEXPECTED_ERROR_MESSAGE);
      const fieldEmail = cause.fieldErrors.email?.[0];
      if (fieldEmail || cause.status === 409) {
        setEmailError(fieldEmail ?? cause.message);
        focusEmail();
        return;
      }
      setError(cause.fieldErrors.role?.[0] ?? cause.message);
    }
  }

  return (
    <form noValidate onSubmit={submit}>
      <DialogTitle className="pr-8 text-[17px] font-extrabold leading-[normal] tracking-normal">{STAFF_COPY.inviteTitle}</DialogTitle>
      <DialogDescription className="mt-1.5 text-[13.5px] leading-[1.55] text-ink-2">{STAFF_COPY.inviteDescription}</DialogDescription>
      <div className="mt-4 grid gap-4">
        <Field id={`${id}-email`} label={STAFF_COPY.email} error={emailError ?? undefined} size="sm">
          <Input
            ref={emailRef}
            size="sm"
            type="email"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            placeholder={STAFF_COPY.emailPlaceholder}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (emailError) setEmailError(null);
            }}
            className="font-semibold"
          />
        </Field>
        <div className="grid gap-1.5">
          <p id={`${id}-role`} className="m-0 text-[12.5px] font-bold">
            {STAFF_COPY.role}
          </p>
          <RadioGroup aria-labelledby={`${id}-role`} value={role} onValueChange={(v) => isStaffRole(v) && setRole(v)} className="gap-2">
            {STAFF_ROLES.map((value) => {
              const itemId = `${id}-role-${value}`;
              const checked = role === value;
              return (
                <label
                  key={value}
                  htmlFor={itemId}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-10 border px-3 py-2.5 transition-colors",
                    checked ? "border-primary bg-lavender-soft" : "border-line-strong bg-surface hover:border-line-input",
                  )}
                >
                  <RadioGroupItem id={itemId} value={value} aria-describedby={`${itemId}-hint`} className="mt-px" />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="text-[13.5px] font-bold">{STAFF_ROLE_LABELS[value]}</span>
                    <span id={`${itemId}-hint`} className="text-[12.5px] font-medium leading-[1.45] text-ink-2">
                      {ROLE_SUMMARIES[value]}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>
        </div>
      </div>
      {error ? (
        <div role="alert" className="mt-3.5 rounded-10 bg-pink-bg px-3 py-2.5 text-[13px] font-bold text-danger">
          {error}
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={close} aria-disabled={busy || undefined}>
          {STAFF_COPY.cancel}
        </Button>
        <Button type="submit" size="sm" loading={busy}>
          {STAFF_COPY.sendInvite}
        </Button>
      </div>
    </form>
  );
}
