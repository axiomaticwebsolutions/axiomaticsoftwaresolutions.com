import type { Metadata } from "next";
import type * as React from "react";
import { AuthShell } from "@/components/auth/auth-shell";

// Every auth page is personal: never indexed (each page sets its own title and canonical URL).
export const metadata: Metadata = { robots: { index: false, follow: true } };

/** /sign-in, /register, /verify, /forgot and /reset share the split layout of Account.dc.html (no store header). */
export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AuthShell>{children}</AuthShell>;
}
