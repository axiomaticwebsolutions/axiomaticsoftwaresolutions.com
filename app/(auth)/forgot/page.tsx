import { emailPrefill } from "@/components/auth/auth-model";
import { ForgotForm } from "@/components/auth/forgot-form";
import {
  authMetadata,
  currentAuthOrNull,
  firstParam,
  signedInDestination,
  type AuthSearchParams,
} from "@/components/auth/page-helpers";
import { SignedInBanner } from "@/components/auth/signed-in-banner";

export const metadata = authMetadata({
  title: "Reset your password",
  description: "Enter your account email and we’ll send a link to choose a new password.",
  path: "/forgot",
});

/** /forgot?email=<prefill>. Signed-in visitors see the prototype's "You’re signed in as …" banner above the form. */
export default async function ForgotPage({ searchParams }: { searchParams: AuthSearchParams }) {
  const params = await searchParams;
  const auth = await currentAuthOrNull();
  return (
    <>
      {auth ? <SignedInBanner email={auth.user.email} accountHref={signedInDestination(auth, null)} /> : null}
      <ForgotForm initialEmail={emailPrefill(firstParam(params.email))} />
    </>
  );
}
