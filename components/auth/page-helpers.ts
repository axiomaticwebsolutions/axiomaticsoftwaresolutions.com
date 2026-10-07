/**
 * Server helpers for the auth pages (app/(auth)/*): the current session (or null when the database is unreachable,
 * so the forms still render), query-string reading and noindex metadata.
 */
import "server-only";
import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { getCurrentAuth, type CurrentAuth } from "@/lib/auth/guards";
import { homeFor, redirectAfterSignIn } from "@/lib/auth/redirect";
import { log } from "@/lib/log";
import { buildMetadata } from "@/lib/seo/metadata";

export type AuthSearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First value of a query parameter. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The signed-in session, or null (also when the session store is unreachable: the page then renders signed out). */
export async function currentAuthOrNull(): Promise<CurrentAuth | null> {
  try {
    return await getCurrentAuth();
  } catch (error) {
    unstable_rethrow(error);
    log.warn("auth_page_session_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Where an already signed-in visitor of /sign-in or /register belongs (staff /admin, unverified /verify, …). */
export function signedInDestination(auth: CurrentAuth, next: string | null): string {
  return redirectAfterSignIn({ kind: auth.user.kind, emailVerified: Boolean(auth.user.emailVerifiedAt) }, next);
}

/** "Go to your account" in the signed-in banner: /admin for staff, /account for customers. */
export function accountHome(auth: CurrentAuth): string {
  return homeFor(auth.user.kind);
}

/** Auth pages are personal and never indexed (links are still followed). */
export function authMetadata(input: { title: string; description: string; path: string }): Metadata {
  return buildMetadata({ ...input, noindex: true });
}
