import type { Metadata } from "next";
import { SecurityView } from "@/components/account/security/security-view";
import { listMySessions } from "@/lib/auth/flows/me";
import { getPortalContext } from "@/lib/portal/context";

export const metadata: Metadata = { title: "Security" };

/**
 * /account/security (Customer Portal.dc.html "Security"; decisions.md Phase 5 "Security page"). Personal settings,
 * open to every team role: profile, password, two-step verification, account data export (Owner only) and active
 * sessions. The user row and sessions come from the request's own session (getPortalContext).
 */
export default async function SecurityPage() {
  const portal = await getPortalContext();
  const { user } = portal.auth;
  const now = new Date();
  const sessions = await listMySessions(portal.auth, now);
  return (
    <SecurityView
      profile={{
        name: user.name,
        phone: user.phone,
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
        twoStepEnabled: user.twoStepEnabled,
      }}
      sessions={sessions}
      now={now.getTime()}
    />
  );
}
