/**
 * GET /api/auth/session -> 200 { user, account, role }: the GET /api/me body for a signed-in user, or
 * { user: null, account: null, role: null } when signed out (never 401). The storefront header's account menu reads
 * it after mount (components/auth/session-store.ts); answering 200 keeps anonymous page views free of failed
 * requests in the browser console. Read-only, Cache-Control: no-store, no CORS (cross-origin pages cannot read it).
 */
import { getMe } from "@/lib/auth/flows/me";
import { getCurrentAuth } from "@/lib/auth/guards";
import { json, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const auth = await getCurrentAuth();
  if (!auth) return json({ user: null, account: null, role: null });
  return json(await getMe(auth));
});
