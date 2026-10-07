import { redirect } from "next/navigation";
import { emailPrefill } from "@/components/auth/auth-model";
import { AUTH_COPY } from "@/components/auth/copy";
import {
  authMetadata,
  currentAuthOrNull,
  firstParam,
  signedInDestination,
  type AuthSearchParams,
} from "@/components/auth/page-helpers";
import { SignInForm } from "@/components/auth/sign-in-form";
import { safeNext } from "@/lib/auth/redirect";

export const metadata = authMetadata({
  title: "Sign in",
  description: "Sign in to Axiomatic to see your licenses, downloads and invoices.",
  path: "/sign-in",
});

/**
 * /sign-in?next=<path>&reset=1&email=<prefill>. One page for customers and staff; a visitor who is already signed in
 * goes straight on (staff to /admin, unverified customers to /verify, others to `next` or /account).
 */
export default async function SignInPage({ searchParams }: { searchParams: AuthSearchParams }) {
  const params = await searchParams;
  const next = safeNext(firstParam(params.next));
  const auth = await currentAuthOrNull();
  if (auth) redirect(signedInDestination(auth, next));
  return (
    <SignInForm
      next={next}
      initialEmail={emailPrefill(firstParam(params.email))}
      initialNotice={firstParam(params.reset) === "1" ? AUTH_COPY.signIn.resetNotice : null}
    />
  );
}
