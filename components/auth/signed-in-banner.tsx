"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { AUTH_COPY } from "./copy";
import { markSignedOut } from "./session-store";

export type SignedInBannerProps = {
  email: string;
  /** "Go to your account" target (/account, or /admin for staff); omitted on /verify, where the portal is not open yet. */
  accountHref?: string | null;
};

const LINK = "font-extrabold text-sage-fg underline underline-offset-[3px] hover:text-ink";

/**
 * Sage banner above the title when a session exists (prototype): "You’re signed in as {email}. Go to your account ·
 * Sign out". Signing out re-renders the page signed out.
 */
export function SignedInBanner({ email, accountHref }: SignedInBannerProps) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch<void>("/api/auth/sign-out", { method: "POST" });
      markSignedOut();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : UNEXPECTED_ERROR_MESSAGE);
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 rounded-16 bg-sage-bg p-4 text-[14.5px] font-semibold text-sage-fg">
      {AUTH_COPY.signedIn.pre} <span className="break-all">{email}</span>.{" "}
      {accountHref ? (
        <>
          <Link href={accountHref} className={cn(LINK, "rounded-6")}>
            {AUTH_COPY.signedIn.goToAccount}
          </Link>
          <span aria-hidden="true"> · </span>
        </>
      ) : null}
      <button
        type="button"
        onClick={signOut}
        aria-busy={busy || undefined}
        className={cn(LINK, "cursor-pointer rounded-6 border-0 bg-transparent p-0 aria-busy:cursor-progress")}
      >
        {AUTH_COPY.signedIn.signOut}
      </button>
      {error ? (
        <span role="alert" className="mt-1.5 block text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
