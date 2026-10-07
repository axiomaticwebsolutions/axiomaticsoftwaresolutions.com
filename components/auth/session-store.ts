/**
 * Browser-side view of "who is signed in" for the storefront header (components/store/account-menu.tsx).
 *
 * Pages stay static: the header asks GET /api/auth/session after mount (200 with `user: null` when signed out, so
 * anonymous page views log no failed request). One request serves every AccountMenu on the page (header + mobile
 * panel); the answer is re-checked when the tab becomes visible again after a minute, and dropped on sign-out.
 * Client-only module (no server imports).
 */
import * as React from "react";
import { apiFetch } from "@/lib/client/api";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  kind: "CUSTOMER" | "STAFF";
  emailVerified: boolean;
  staffRole: string | null;
};

export type SessionAccount = { id: string; legalName: string };

/** GET /api/auth/session (the GET /api/me shape, with nulls when signed out). */
export type SessionResponse = { user: SessionUser | null; account: SessionAccount | null; role: string | null };

export type SessionSnapshot =
  | { status: "unknown" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: SessionUser; account: SessionAccount | null; role: string | null };

export const SESSION_PATH = "/api/auth/session";
/** Re-check on tab focus only when the last answer is older than this. */
export const SESSION_RECHECK_MS = 60_000;

const UNKNOWN: SessionSnapshot = { status: "unknown" };
const SIGNED_OUT: SessionSnapshot = { status: "signed-out" };

let snapshot: SessionSnapshot = UNKNOWN;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: SessionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** The snapshot for a /api/auth/session body. */
export function snapshotFrom(body: SessionResponse | null | undefined): SessionSnapshot {
  if (!body?.user) return SIGNED_OUT;
  return { status: "signed-in", user: body.user, account: body.account ?? null, role: body.role ?? null };
}

/** Loads the session once (or again with `force`). Failures keep the current state (the header shows "Sign in"). */
export function loadSession(opts: { force?: boolean } = {}): Promise<void> {
  if (inflight) return inflight;
  if (!opts.force && snapshot.status !== "unknown") return Promise.resolve();
  inflight = (async () => {
    try {
      const body = await apiFetch<SessionResponse>(SESSION_PATH);
      loadedAt = Date.now();
      emit(snapshotFrom(body));
    } catch {
      // Network or server trouble: leave the header as it is.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** After POST /api/auth/sign-out succeeded. */
export function markSignedOut(): void {
  loadedAt = Date.now();
  emit(SIGNED_OUT);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current session snapshot; "unknown" on the server and until the first answer. Starts the load on mount. */
export function useSession(): SessionSnapshot {
  const value = React.useSyncExternalStore(subscribe, () => snapshot, () => UNKNOWN);

  React.useEffect(() => {
    void loadSession();
    const recheck = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt > SESSION_RECHECK_MS) {
        void loadSession({ force: true });
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void loadSession({ force: true });
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return value;
}
