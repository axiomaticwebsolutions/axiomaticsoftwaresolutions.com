"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Field, type FormError } from "@/components/ui/field";
import { AuthErrorBanner, AuthErrorSummary, AuthHeading, AuthInput, AuthNotice, AuthSubmit, leaveAuthPage } from "@/components/auth/auth-ui";
import { NewPasswordField } from "@/components/auth/new-password-field";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { STAFF_NAME_MAX } from "@/lib/admin/staff/model";
import {
  isStaffInviteGoneCode,
  isStaffInviteProblemCode,
  STAFF_INVITE_COPY,
  STAFF_INVITE_FIELDS,
  staffInviteProblemAction,
  validateStaffInvite,
  type StaffInviteField,
  type StaffInviteProblemCode,
} from "./staff-invite-model";

export type StaffInviteSummary = {
  email: string;
  roleLabel: string;
  roleSummary: string;
  inviterName: string | null;
  /** "14 Oct 2026" (IST). */
  expiresLabel: string;
};

export type StaffInviteViewProps =
  | { state: "problem"; code: StaffInviteProblemCode; message: string; signedInHref: string | null }
  | {
      state: "ready";
      token: string;
      invite: StaffInviteSummary;
      /** Someone is signed in on this browser: they must sign out first (server message). */
      signedInMessage: string | null;
      signedInHref: string | null;
    };

type Problem = { code: StaffInviteProblemCode; message: string };
const BUTTON_LINK = "mt-[22px] h-[52px] w-full py-0 text-base font-extrabold shadow-none";

/**
 * /staff-invite?token=… (new screen in the auth layout): who invited you, the role and what it allows, then your name
 * and a password. Accepting signs you in and opens /admin. Expired, revoked, used and invalid links explain
 * themselves; someone signed in on this browser is asked to sign out first.
 */
export function StaffInviteView(props: StaffInviteViewProps) {
  const [gone, setGone] = React.useState<Problem | null>(null);
  if (props.state === "problem") return <ProblemView code={props.code} message={props.message} signedInHref={props.signedInHref} />;
  if (gone) return <ProblemView {...gone} signedInHref={props.signedInHref} />;
  return (
    <>
      <AuthHeading title={STAFF_INVITE_COPY.title} subtitle={STAFF_INVITE_COPY.subtitle(props.invite.inviterName, props.invite.roleLabel)} />
      <RoleCard invite={props.invite} />
      {props.signedInMessage ? <AuthErrorBanner>{props.signedInMessage}</AuthErrorBanner> : <AcceptForm token={props.token} email={props.invite.email} onGone={setGone} />}
    </>
  );
}

function ProblemView({ code, message, signedInHref }: Problem & { signedInHref: string | null }) {
  const action = staffInviteProblemAction(code, signedInHref);
  return (
    <>
      <AuthHeading title={STAFF_INVITE_COPY.problems[code]} />
      {code === "invite_used" ? <AuthNotice>{message}</AuthNotice> : <AuthErrorBanner>{message}</AuthErrorBanner>}
      <Button asChild size="lg" className={BUTTON_LINK}>
        <Link href={action.href}>{action.label}</Link>
      </Button>
    </>
  );
}

function RoleCard({ invite }: { invite: StaffInviteSummary }) {
  return (
    <div className="mt-[22px] rounded-16 border border-lavender-line bg-lavender-soft p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-12 bg-lavender-bg text-lavender-fg">
          <Icon name="badge" size={22} />
        </span>
        <div className="min-w-0">
          <p className="m-0 text-[11.5px] font-extrabold uppercase tracking-[0.08em] text-ink-2">{STAFF_INVITE_COPY.yourRole}</p>
          <p className="m-0 mt-0.5 text-[16px] font-extrabold">{invite.roleLabel}</p>
          <p className="m-0 mt-1 text-[14px] leading-[1.5] text-ink-2">{invite.roleSummary}</p>
        </div>
      </div>
      <p className="mb-0 mt-3 border-t border-lavender-line pt-3 text-[13.5px] font-semibold leading-[1.5] text-ink-2">
        {STAFF_INVITE_COPY.invitationFor} <span className="break-all font-bold text-ink">{invite.email}</span>
        <span aria-hidden="true"> · </span>
        <span className="whitespace-nowrap">{STAFF_INVITE_COPY.expires(invite.expiresLabel)}</span>
      </p>
    </div>
  );
}

const FIELD_IDS: Record<StaffInviteField, string> = { name: "staff-invite-name", password: "staff-invite-password" };
const SUMMARY_ID = "staff-invite-errors";

function AcceptForm({ token, email, onGone }: { token: string; email: string; onGone: (problem: Problem) => void }) {
  const [values, setValues] = React.useState<Record<StaffInviteField, string>>({ name: "", password: "" });
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<StaffInviteField, string>>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [visible, setVisible] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [focus, setFocus] = React.useState<{ id: string; at: number } | null>(null);

  React.useEffect(() => {
    if (focus) document.getElementById(focus.id)?.focus();
  }, [focus]);

  const clientErrors = tried ? validateStaffInvite(values) : {};
  const errors: Partial<Record<StaffInviteField, string>> = { ...serverErrors, ...clientErrors };
  const summary: FormError[] = STAFF_INVITE_FIELDS.flatMap((key) => {
    const message = errors[key];
    return message ? [{ fieldId: FIELD_IDS[key], message }] : [];
  });

  function set(key: StaffInviteField, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setVisible(false);
    setError(null);
    if (Object.values(validateStaffInvite(values)).some(Boolean)) {
      setTried(true);
      setServerErrors({});
      setFocus({ id: SUMMARY_ID, at: Date.now() });
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{ redirectTo: string }>("/api/staff-invites/accept", {
        method: "POST",
        body: { token, name: values.name.trim(), password: values.password },
      });
      // Stays busy while the console opens.
      leaveAuthPage(res.redirectTo, "/admin");
    } catch (cause) {
      setBusy(false);
      if (!(cause instanceof ApiClientError)) return setError(UNEXPECTED_ERROR_MESSAGE);
      if (isStaffInviteGoneCode(cause.code) && isStaffInviteProblemCode(cause.code)) return onGone({ code: cause.code, message: cause.message });
      if (cause.code === "validation_failed") {
        const fields: Partial<Record<StaffInviteField, string>> = {};
        for (const key of STAFF_INVITE_FIELDS) {
          const message = cause.fieldErrors[key]?.[0];
          if (message) fields[key] = message;
        }
        setServerErrors(fields);
        setTried(true);
        setFocus({ id: SUMMARY_ID, at: Date.now() });
        return;
      }
      setError(cause.message);
    }
  }

  return (
    <>
      <p className="mb-0 mt-[18px] text-[14.5px] leading-[1.55] text-ink-2">{STAFF_INVITE_COPY.intro}</p>
      {summary.length > 0 ? <AuthErrorSummary id={SUMMARY_ID} errors={summary} /> : error ? <AuthErrorBanner>{error}</AuthErrorBanner> : null}
      <form noValidate onSubmit={submit} className="mt-[18px] grid gap-4">
        <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
        <Field id={FIELD_IDS.name} label={STAFF_INVITE_COPY.fullName} error={errors.name}>
          <AuthInput name="name" autoComplete="name" maxLength={STAFF_NAME_MAX} value={values.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <NewPasswordField
          id={FIELD_IDS.password}
          label={STAFF_INVITE_COPY.password}
          value={values.password}
          onChange={(value) => set("password", value)}
          error={errors.password}
          visible={visible}
          onVisibleChange={setVisible}
        />
        <AuthSubmit busy={busy}>{STAFF_INVITE_COPY.accept}</AuthSubmit>
      </form>
      <p className="mb-0 mt-4 text-[13px] leading-[1.5] text-ink-2">{STAFF_INVITE_COPY.separate}</p>
    </>
  );
}
