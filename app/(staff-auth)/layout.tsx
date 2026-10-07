import type { Metadata } from "next";
import type * as React from "react";
import { STAFF_INVITE_ASIDE } from "@/components/admin/staff/staff-invite-model";
import { AuthShell } from "@/components/auth/auth-shell";

// Like app/(auth)/layout.tsx: personal token pages are never indexed (the page sets its own title and canonical URL).
export const metadata: Metadata = { robots: { index: false, follow: true } };

/**
 * /staff-invite: the auth pages' split layout with a staff brand panel. The customer copy of the (auth) group ("Your
 * licenses, downloads and invoices…") would contradict a page that says staff accounts cannot buy software.
 */
export default function StaffAuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AuthShell aside={STAFF_INVITE_ASIDE}>{children}</AuthShell>;
}
