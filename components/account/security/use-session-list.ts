"use client";

import * as React from "react";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import type { SessionView } from "./security-model";

export type SessionList = {
  sessions: SessionView[];
  /** The time relative session times are measured from (the server's first, then each reload). */
  now: Date;
  /** Re-reads GET /api/me/sessions (after a password change or a sign-out); a failure is a toast. */
  reload: () => Promise<void>;
};

/**
 * The "Active sessions" list behind the portal Security page and Admin > My profile: the server's first render, then
 * GET /api/me/sessions after every change.
 */
export function useSessionList(initialSessions: SessionView[], serverNow: number): SessionList {
  const [sessions, setSessions] = React.useState(initialSessions);
  const [now, setNow] = React.useState(() => new Date(serverNow));

  const reload = React.useCallback(async () => {
    try {
      const body = await apiFetch<{ sessions: SessionView[] }>("/api/me/sessions");
      setSessions(body.sessions);
      setNow(new Date());
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    }
  }, []);

  return { sessions, now, reload };
}
