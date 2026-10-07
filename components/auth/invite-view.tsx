"use client";

import Link from "next/link";
import * as React from "react";
import { saveSignInPrefill } from "@/components/store/order/session-keys";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Field, type FormError } from "@/components/ui/field";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import {
  AuthErrorBanner,
  AuthErrorSummary,
  AuthFooter,
  AuthHeading,
  AuthInput,
  AuthNotice,
  AuthSubmit,
  leaveAuthPage,
} from "./auth-ui";
import {
  INVITE_COPY,
  isInviteGoneCode,
  isInviteProblemCode,
  NEW_MEMBER_FIELDS,
  problemAction,
  problemTitle,
  signInToAcceptHref,
  validateNewMember,
  type InviteProblemCode,
  type NewMemberField,
} from "./invite-model";
import { NewPasswordField } from "./new-password-field";

export type InviteSummary = {
  email: string;
  accountName: string;
  roleLabel: string;
  roleDescription: string;
  inviterName: string | null;
  /** "14 Oct 2026" (IST). */
  expiresLabel: string;
  /** The invitee already has a password: they sign in to accept instead of creating one. */
  accountExists: boolean;
};

export type InviteViewProps =
  | { state: "problem"; code: InviteProblemCode; message: string; signedIn: boolean; accountHref: string }
  | {
      state: "ready";
      token: string;
      invite: InviteSummary;
      viewer: { signedIn: boolean; isInvitee: boolean };
      accountHref: string;
      /** Server copy: "Sign in as {email} to accept this invitation." and the wrong-account message. */
      messages: { signInToAccept: string; wrongAccount: string };
    };

type Problem = { code: InviteProblemCode; message: string };
type Mode = "accept" | "signIn" | "wrong" | "new";

const BUTTON_LINK = "mt-[22px] h-[52px] w-full py-0 text-base font-extrabold shadow-none";

/**
 * /invite?token=… (new screen in the auth layout): the invitation (business, role and what it allows, expiry) and the
 * way to accept it. A signed-in invitee accepts with one button; someone who already has an account signs in as that
 * email first (and comes back here); a new person chooses a name and a password; anyone signed in as someone else
 * is asked to sign out. Accepting starts a session in the joined business and opens /account.
 */
export function InviteView(props: InviteViewProps) {
  const [problem, setProblem] = React.useState<Problem | null>(null);
  if (props.state === "problem") {
    return <InviteProblem code={props.code} message={props.message} signedIn={props.signedIn} accountHref={props.accountHref} />;
  }
  if (problem) {
    return <InviteProblem {...problem} signedIn={props.viewer.signedIn} accountHref={props.accountHref} />;
  }
  return <InviteReady {...props} onGone={setProblem} />;
}

function InviteProblem({ code, message, signedIn, accountHref }: Problem & { signedIn: boolean; accountHref: string }) {
  const action = problemAction(code, signedIn, accountHref);
  return (
    <>
      <AuthHeading title={problemTitle(code)} />
      {code === "invite_used" ? <AuthNotice>{message}</AuthNotice> : <AuthErrorBanner>{message}</AuthErrorBanner>}
      <Button asChild size="lg" className={BUTTON_LINK}>
        <Link href={action.href}>{action.label}</Link>
      </Button>
      {!signedIn && code !== "invite_used" ? (
        <AuthFooter items={[{ pre: INVITE_COPY.memberPre, label: INVITE_COPY.signIn, href: "/sign-in" }]} />
      ) : null}
    </>
  );
}

/** Business, role (with what it allows) and the invited address. */
function InviteCard({ invite }: { invite: InviteSummary }) {
  return (
    <div className="mt-[22px] rounded-16 border border-lavender-line bg-lavender-soft p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-12 bg-lavender-bg text-lavender-fg">
          <Icon name="group" size={22} />
        </span>
        <div className="min-w-0">
          <p className="m-0 text-[11.5px] font-extrabold uppercase tracking-[0.08em] text-ink-2">{INVITE_COPY.yourRole}</p>
          <p className="m-0 mt-0.5 text-[16px] font-extrabold">{invite.roleLabel}</p>
          <p className="m-0 mt-1 text-[14px] leading-[1.5] text-ink-2">{invite.roleDescription}</p>
        </div>
      </div>
      <p className="mb-0 mt-3 border-t border-lavender-line pt-3 text-[13.5px] font-semibold leading-[1.5] text-ink-2">
        {INVITE_COPY.invitationFor} <span className="break-all font-bold text-ink">{invite.email}</span>
        <span aria-hidden="true"> · </span>
        <span className="whitespace-nowrap">{INVITE_COPY.expires(invite.expiresLabel)}</span>
      </p>
    </div>
  );
}

type ReadyProps = Extract<InviteViewProps, { state: "ready" }> & { onGone: (problem: Problem) => void };

function initialMode(viewer: ReadyProps["viewer"], accountExists: boolean): Mode {
  if (viewer.isInvitee) return "accept";
  if (viewer.signedIn) return "wrong";
  return accountExists ? "signIn" : "new";
}

type AcceptResponse = { redirectTo: string };

/** Sends the acceptance: "left" while the page navigates to the account, else the handled error (or null). */
type Accept = (body: { name?: string; password?: string }) => Promise<ApiClientError | "left" | null>;

function InviteReady({ token, invite, viewer, messages, onGone }: ReadyProps) {
  const [mode, setMode] = React.useState<Mode>(() => initialMode(viewer, invite.accountExists));
  const [error, setError] = React.useState<string | null>(null);

  const accept: Accept = async (body) => {
    setError(null);
    try {
      const res = await apiFetch<AcceptResponse>("/api/invites/accept", { method: "POST", body: { token, ...body } });
      leaveAuthPage(res.redirectTo, "/account");
      return "left";
    } catch (cause) {
      if (!(cause instanceof ApiClientError)) {
        setError(UNEXPECTED_ERROR_MESSAGE);
        return null;
      }
      if (isInviteGoneCode(cause.code) && isInviteProblemCode(cause.code)) {
        onGone({ code: cause.code, message: cause.message });
      } else if (cause.code === "sign_in_required") {
        setMode("signIn");
      } else if (cause.code === "wrong_account") {
        setMode("wrong");
      } else if (cause.code !== "validation_failed") {
        setError(cause.message);
      }
      return cause;
    }
  };

  return (
    <>
      <AuthHeading title={INVITE_COPY.title(invite.accountName)} subtitle={INVITE_COPY.subtitle(invite.inviterName, invite.roleLabel)} />
      <InviteCard invite={invite} />
      {mode === "accept" ? <AcceptForm accept={accept} error={error} /> : null}
      {mode === "new" ? <NewMemberForm email={invite.email} accept={accept} error={error} /> : null}
      {mode === "wrong" ? <AuthErrorBanner>{messages.wrongAccount}</AuthErrorBanner> : null}
      {mode === "signIn" ? (
        <>
          <AuthNotice>{messages.signInToAccept}</AuthNotice>
          <Button asChild size="lg" className={BUTTON_LINK}>
            <Link href={signInToAcceptHref(token)} onClick={() => saveSignInPrefill(invite.email)}>
              {INVITE_COPY.signInToAccept}
            </Link>
          </Button>
          <AuthFooter items={[{ label: INVITE_COPY.forgot, href: "/forgot" }]} />
        </>
      ) : null}
    </>
  );
}

/** A signed-in invitee: one button. */
function AcceptForm({ accept, error }: { accept: Accept; error: string | null }) {
  const [busy, setBusy] = React.useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    // Stays busy while the page leaves for the account.
    if ((await accept({})) !== "left") setBusy(false);
  }
  return (
    <>
      {error ? <AuthErrorBanner>{error}</AuthErrorBanner> : null}
      <form noValidate onSubmit={submit} className="mt-[22px]">
        <AuthSubmit busy={busy}>{INVITE_COPY.accept}</AuthSubmit>
      </form>
    </>
  );
}

const FIELD_IDS: Record<NewMemberField, string> = { name: "invite-name", password: "invite-password" };
const SUMMARY_ID = "invite-errors";

/** A new person: full name and a password (policy hint), then accept. */
function NewMemberForm({ email, accept, error }: { email: string; accept: Accept; error: string | null }) {
  const [values, setValues] = React.useState<Record<NewMemberField, string>>({ name: "", password: "" });
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<NewMemberField, string>>>({});
  const [showPassword, setShowPassword] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [focusRequest, setFocusRequest] = React.useState<{ id: string; at: number } | null>(null);

  React.useEffect(() => {
    if (focusRequest) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  const clientErrors = tried ? validateNewMember(values) : {};
  const errors: Partial<Record<NewMemberField, string>> = { ...serverErrors, ...clientErrors };
  const summary: FormError[] = NEW_MEMBER_FIELDS.flatMap((key) => {
    const message = errors[key];
    return message ? [{ fieldId: FIELD_IDS[key], message }] : [];
  });

  function set(key: NewMemberField, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setShowPassword(false);
    const problems = validateNewMember(values);
    if (Object.values(problems).some(Boolean)) {
      setTried(true);
      setServerErrors({});
      setFocusRequest({ id: SUMMARY_ID, at: Date.now() });
      return;
    }
    setBusy(true);
    const failure = await accept({ name: values.name.trim(), password: values.password });
    if (failure === "left") return;
    setBusy(false);
    if (failure?.code === "validation_failed") {
      const fields: Partial<Record<NewMemberField, string>> = {};
      for (const key of NEW_MEMBER_FIELDS) {
        const message = failure.fieldErrors[key]?.[0];
        if (message) fields[key] = message;
      }
      setServerErrors(fields);
      setTried(true);
      setFocusRequest({ id: SUMMARY_ID, at: Date.now() });
    }
  }

  return (
    <>
      <p className="mb-0 mt-[18px] text-[14.5px] leading-[1.55] text-ink-2">{INVITE_COPY.newAccount}</p>
      {summary.length > 0 ? (
        <AuthErrorSummary id={SUMMARY_ID} errors={summary} />
      ) : error ? (
        <AuthErrorBanner>{error}</AuthErrorBanner>
      ) : null}
      <form noValidate onSubmit={submit} className="mt-[18px] grid gap-4">
        <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
        <Field id={FIELD_IDS.name} label={INVITE_COPY.fullName} error={errors.name}>
          <AuthInput
            name="name"
            autoComplete="name"
            maxLength={120}
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>
        <NewPasswordField
          id={FIELD_IDS.password}
          label={INVITE_COPY.password}
          value={values.password}
          onChange={(value) => set("password", value)}
          error={errors.password}
          visible={showPassword}
          onVisibleChange={setShowPassword}
        />
        <AuthSubmit busy={busy}>{INVITE_COPY.accept}</AuthSubmit>
      </form>
    </>
  );
}
