import { redirect } from "next/navigation";
import {
  authMetadata,
  currentAuthOrNull,
  firstParam,
  signedInDestination,
  type AuthSearchParams,
} from "@/components/auth/page-helpers";
import { SignedInBanner } from "@/components/auth/signed-in-banner";
import { VerifyForm } from "@/components/auth/verify-form";
import { safeNext } from "@/lib/auth/redirect";

export const metadata = authMetadata({
  title: "Verify your email",
  description: "Enter the 6-digit code we emailed you to verify your Axiomatic account.",
  path: "/verify",
});

/**
 * /verify?next=<path>&created=1. Needs the session of an unverified customer; verified users (and staff) go on to
 * where they belong, signed-out visitors see "Sign in again to verify your email."
 */
export default async function VerifyPage({ searchParams }: { searchParams: AuthSearchParams }) {
  const params = await searchParams;
  const next = safeNext(firstParam(params.next));
  const auth = await currentAuthOrNull();
  if (auth && (auth.user.kind === "STAFF" || auth.user.emailVerifiedAt)) redirect(signedInDestination(auth, next));
  const email = auth?.user.email ?? null;
  return (
    <>
      {email ? <SignedInBanner email={email} /> : null}
      <VerifyForm
        key={email ?? "signed-out"}
        email={email}
        next={next}
        created={email !== null && firstParam(params.created) === "1"}
      />
    </>
  );
}
