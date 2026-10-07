import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { continuePath, emailPrefill, trialSlug } from "@/components/auth/auth-model";
import { AUTH_COPY } from "@/components/auth/copy";
import {
  authMetadata,
  currentAuthOrNull,
  firstParam,
  signedInDestination,
  type AuthSearchParams,
} from "@/components/auth/page-helpers";
import { RegisterForm } from "@/components/auth/register-form";
import { safeNext } from "@/lib/auth/redirect";

type RegisterPageProps = { searchParams: AuthSearchParams };

export async function generateMetadata({ searchParams }: RegisterPageProps): Promise<Metadata> {
  const trial = trialSlug(firstParam((await searchParams).trial));
  return authMetadata({
    title: trial ? AUTH_COPY.register.trialTitle : AUTH_COPY.register.title,
    description: "Create an Axiomatic account to manage your licenses, downloads and GST invoices.",
    path: "/register",
  });
}

/**
 * /register?next=<path>&trial=<product slug>&email=<prefill>. The trial slug travels inside `next`
 * (/account/software?trial=<slug>) through email verification. Signed-in visitors go straight on.
 */
export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const params = await searchParams;
  const trial = trialSlug(firstParam(params.trial));
  const continueTo = continuePath(safeNext(firstParam(params.next)), trial);
  const auth = await currentAuthOrNull();
  if (auth) redirect(signedInDestination(auth, continueTo));
  return <RegisterForm continueTo={continueTo} trial={trial !== null} initialEmail={emailPrefill(firstParam(params.email))} />;
}
