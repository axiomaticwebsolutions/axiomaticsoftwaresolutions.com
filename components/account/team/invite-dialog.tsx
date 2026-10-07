"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import type { InviteRole } from "@/lib/validation/team";
import { DIALOG_BUTTON_CLASS } from "./portal-confirm-dialog";
import {
  DEFAULT_ROLE,
  INVITE_ROLE_CHOICES,
  inviteEmailError,
  isInviteRole,
  normalizedInviteEmail,
  TEAM_COPY,
} from "./team-model";

export type InviteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Business name for "They’ll get an email with a link to join {business}." */
  businessName: string;
  /** After the API accepted the invitation (the address as stored; `emailSent` false when its email failed). */
  onInvited: (email: string, emailSent: boolean) => void;
};

/**
 * "Invite member" (prototype inline form, as a dialog with the role descriptions): Work email + Role (Billing admin,
 * Technical contact by default, Viewer) and Send invite. Errors are the API's ("Enter a valid email address.",
 * "This person is already on your team." under the email; team limit and rate limits in the alert).
 */
export function InviteDialog({ open, onOpenChange, businessName, onInvited }: InviteDialogProps) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[460px] gap-0 rounded-18 p-[22px] leading-[normal] sm:p-[22px]">
        {/* Content unmounts on close: the form starts empty every time. */}
        <InviteForm
          businessName={businessName}
          busy={busy}
          setBusy={setBusy}
          onCancel={() => onOpenChange(false)}
          onInvited={(email, emailSent) => {
            onOpenChange(false);
            onInvited(email, emailSent);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

type InviteFormProps = {
  businessName: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onInvited: (email: string, emailSent: boolean) => void;
};

function InviteForm({ businessName, busy, setBusy, onCancel, onInvited }: InviteFormProps) {
  const id = React.useId();
  const emailId = `${id}-email`;
  const emailRef = React.useRef<HTMLInputElement>(null);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<InviteRole>(DEFAULT_ROLE);
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  function focusEmail() {
    window.requestAnimationFrame(() => emailRef.current?.focus());
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const problem = inviteEmailError(email);
    setError(null);
    if (problem) {
      setEmailError(problem);
      focusEmail();
      return;
    }
    setEmailError(null);
    setBusy(true);
    try {
      const result = await apiFetch<{ emailSent?: boolean }>("/api/account/team", {
        method: "POST",
        body: { email: normalizedInviteEmail(email), role },
      });
      setBusy(false);
      onInvited(normalizedInviteEmail(email), result.emailSent !== false);
    } catch (cause) {
      setBusy(false);
      if (!(cause instanceof ApiClientError)) return setError(UNEXPECTED_ERROR_MESSAGE);
      const fieldEmail = cause.fieldErrors.email?.[0];
      if (fieldEmail) {
        setEmailError(fieldEmail);
        focusEmail();
        return;
      }
      setError(cause.fieldErrors.role?.[0] ?? cause.message);
    }
  }

  return (
    <form noValidate onSubmit={submit}>
      <DialogTitle className="pr-8 text-[18px] font-extrabold leading-[normal] tracking-normal">{TEAM_COPY.inviteTitle}</DialogTitle>
      <DialogDescription className="mt-2 text-[14.5px] leading-[1.6] text-ink-2">
        {TEAM_COPY.inviteDescription(businessName)}
      </DialogDescription>
      <div className="mt-4 grid gap-4">
        <Field id={emailId} label={TEAM_COPY.email} error={emailError ?? undefined}>
          <Input
            ref={emailRef}
            type="email"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={320}
            placeholder={TEAM_COPY.emailPlaceholder}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (emailError) setEmailError(null);
            }}
            className="h-10 rounded-10 px-3 text-[14px] font-semibold"
          />
        </Field>
        <div className="grid gap-1.5">
          <p id={`${id}-role`} className="m-0 text-[14px] font-bold">
            {TEAM_COPY.role}
          </p>
          <RadioGroup
            aria-labelledby={`${id}-role`}
            value={role}
            onValueChange={(value) => {
              if (isInviteRole(value)) setRole(value);
            }}
            className="gap-2"
          >
            {INVITE_ROLE_CHOICES.map((choice) => {
              const itemId = `${id}-role-${choice.value}`;
              const checked = role === choice.value;
              return (
                <label
                  key={choice.value}
                  htmlFor={itemId}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-12 border px-3 py-2.5 transition-colors",
                    checked ? "border-primary bg-lavender-soft" : "border-line-strong bg-surface hover:border-line-input",
                  )}
                >
                  <RadioGroupItem id={itemId} value={choice.value} aria-describedby={`${itemId}-hint`} className="mt-px" />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="text-[14px] font-bold">{choice.label}</span>
                    <span id={`${itemId}-hint`} className="text-[13px] font-medium leading-[1.45] text-ink-2">
                      {choice.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>
        </div>
      </div>
      {error ? (
        <div role="alert" className="mt-3.5 rounded-10 bg-pink-bg px-3 py-2.5 text-[13.5px] font-bold text-danger">
          {error}
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} aria-disabled={busy || undefined} className={DIALOG_BUTTON_CLASS}>
          {TEAM_COPY.cancel}
        </Button>
        <Button type="submit" loading={busy} className={DIALOG_BUTTON_CLASS}>
          {TEAM_COPY.sendInvite}
        </Button>
      </div>
    </form>
  );
}
