"use client";

import { PageHeader } from "@/components/account/page-header";
import { PasswordForm } from "./password-form";
import { ProfileForm } from "./profile-form";
import { ProtectionCard } from "./protection-card";
import { SessionsCard } from "./sessions-card";
import { SECURITY_COPY, type SessionView } from "./security-model";
import { useSessionList } from "./use-session-list";

export type SecurityViewProps = {
  profile: { name: string; phone: string | null; email: string; emailVerified: boolean; twoStepEnabled: boolean };
  /** GET /api/me/sessions body, loaded by the server page (this device first). */
  sessions: SessionView[];
  /** Server time (ms) for the first render's relative times. */
  now: number;
};

/**
 * Portal "Security" (Customer Portal.dc.html vSecurity; decisions.md Phase 5 "Security page"), open to every team
 * role: profile, password, two-step + account data (export: Owner only) and active sessions, in the prototype's
 * auto-fit grid of 400px columns.
 */
export function SecurityView({ profile, sessions: initialSessions, now: serverNow }: SecurityViewProps) {
  const { sessions, now, reload: reloadSessions } = useSessionList(initialSessions, serverNow);

  return (
    <>
      <PageHeader title={SECURITY_COPY.title} description={SECURITY_COPY.description} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,400px),1fr))] items-start gap-4">
        <ProfileForm name={profile.name} phone={profile.phone} email={profile.email} emailVerified={profile.emailVerified} />
        <PasswordForm email={profile.email} onChanged={() => void reloadSessions()} />
        <ProtectionCard twoStepEnabled={profile.twoStepEnabled} />
        <SessionsCard sessions={sessions} now={now} onChanged={reloadSessions} />
      </div>
    </>
  );
}
