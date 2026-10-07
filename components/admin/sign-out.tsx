"use client";

import * as React from "react";
import { errorMessage } from "@/components/admin/admin-toaster";
import { toast } from "@/components/ui/sonner";
import { SIGN_IN_PATH } from "@/lib/auth/redirect";
import { apiFetch } from "@/lib/client/api";
import { cn } from "@/lib/utils";

/** POST /api/auth/sign-out (the session is revoked), then the sign-in page. */
export function useStaffSignOut() {
  const [busy, setBusy] = React.useState(false);
  const signOut = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch<void>("/api/auth/sign-out", { method: "POST" });
      window.location.assign(SIGN_IN_PATH);
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }, [busy]);
  return { signOut, busy };
}

/** A plain "Sign out" button (full-page admin notices). */
export function StaffSignOutButton({ className, children = "Sign out" }: { className?: string; children?: React.ReactNode }) {
  const { signOut, busy } = useStaffSignOut();
  return (
    <button
      type="button"
      onClick={() => void signOut()}
      aria-busy={busy || undefined}
      className={cn("cursor-pointer aria-busy:cursor-progress", className)}
    >
      {children}
    </button>
  );
}
