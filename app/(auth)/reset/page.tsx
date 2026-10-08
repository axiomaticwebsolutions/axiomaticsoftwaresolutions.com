import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import {
  authMetadata,
  currentAuthOrNull,
  firstParam,
  signedInDestination,
  type AuthSearchParams,
} from "@/components/auth/page-helpers";
import { ResetForm, ResetLinkProblem } from "@/components/auth/reset-form";
import { SignedInBanner } from "@/components/auth/signed-in-banner";
import { AUTH_MESSAGES } from "@/lib/auth/flows/common";
import { inspectResetToken } from "@/lib/auth/flows/reset-password";
import { ApiError } from "@/lib/http";
import { resetTokenSchema } from "@/lib/validation/auth";

export const metadata: Metadata = {
  ...authMetadata({
    title: "Choose your password",
    description: "Choose a password for your Axiomatic account.",
    path: "/reset",
  }),
  // The URL carries the reset token: never send it on as a Referer.
  referrer: "no-referrer",
};

type LinkState = { ok: true; token: string; email: string; mode: "set" | "reset" } | { ok: false; message: string };

/** Looks the token up without using it (unknown, used and expired links get the API's message). */
async function linkState(raw: string | undefined): Promise<LinkState> {
  const parsed = resetTokenSchema.safeParse(raw ?? "");
  if (!parsed.success) return { ok: false, message: AUTH_MESSAGES.resetInvalid };
  try {
    const { email, mode } = await inspectResetToken(parsed.data);
    return { ok: true, token: parsed.data, email, mode };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError) return { ok: false, message: error.message };
    throw error;
  }
}

/** /reset?token=… from the password-reset email, or a set-password link staff created ("Set your password"). */
export default async function ResetPage({ searchParams }: { searchParams: AuthSearchParams }) {
  const params = await searchParams;
  const [state, auth] = await Promise.all([linkState(firstParam(params.token)), currentAuthOrNull()]);
  return (
    <>
      {auth ? <SignedInBanner email={auth.user.email} accountHref={signedInDestination(auth, null)} /> : null}
      {state.ok ? <ResetForm token={state.token} email={state.email} mode={state.mode} /> : <ResetLinkProblem message={state.message} />}
    </>
  );
}
