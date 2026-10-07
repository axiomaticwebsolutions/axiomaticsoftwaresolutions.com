/**
 * POST /api/auth/sign-out (no body or `{}`) -> 204. Revokes the current DB session, clears the cookie and issues
 * an anonymous CSRF token. Signed-out callers also get 204.
 */
import { authWithCsrf, endSessionCookies, parseEmptyBody } from "@/lib/auth/flows/route-helpers";
import { signOut } from "@/lib/auth/flows/sign-out";
import { route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const auth = await authWithCsrf(req);
  await parseEmptyBody(req);
  await signOut(auth?.session.id);
  await endSessionCookies();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});
