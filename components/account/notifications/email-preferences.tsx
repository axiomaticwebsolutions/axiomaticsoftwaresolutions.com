"use client";

import * as React from "react";
import { emailPrefRows, NOTIFICATIONS_COPY, type EmailPrefsView } from "@/components/account/notifications/model";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import type { EmailPrefKey } from "@/lib/validation/portal";

/**
 * "Email preferences" card (prototype): Renewal reminders, New versions & release notes, Ticket replies, Offers &
 * announcements. Each switch saves immediately (PATCH /api/account/notifications, no toast on success, as in the
 * prototype); a failed save puts the switch back and says why. Turning offers on records the consent time, shown
 * under the switch.
 */
export function EmailPreferences({ initial, className }: { initial: EmailPrefsView; className?: string }) {
  const [prefs, setPrefs] = React.useState(initial);
  const [seen, setSeen] = React.useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setPrefs(initial);
  }
  const [saving, setSaving] = React.useState<ReadonlySet<EmailPrefKey>>(new Set());
  const rows = emailPrefRows(prefs);

  async function toggle(key: EmailPrefKey, on: boolean) {
    if (saving.has(key)) return;
    const before = prefs;
    setPrefs((prev) => ({ ...prev, [key]: on }));
    setSaving((prev) => new Set(prev).add(key));
    try {
      const res = await apiFetch<{ prefs: EmailPrefsView }>("/api/account/notifications", { method: "PATCH", body: { [key]: on } });
      setPrefs(res.prefs);
    } catch (error) {
      setPrefs((prev) => ({ ...prev, [key]: before[key], offersConsentAt: before.offersConsentAt }));
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <section aria-labelledby="email-prefs-title" className={cn("rounded-16 border border-line-alt bg-surface px-[18px] py-4", className)}>
      <h2 id="email-prefs-title" className="m-0 text-[15px] font-extrabold">
        {NOTIFICATIONS_COPY.prefsTitle}
      </h2>
      <ul className="m-0 mt-2 grid list-none p-0">
        {rows.map((row) => {
          const labelId = `pref-${row.key}`;
          const noteId = row.note ? `pref-${row.key}-note` : undefined;
          return (
            <li key={row.key} className="border-b border-line-subtle py-2.5">
              <div className="flex items-center justify-between gap-3 text-[14px] font-semibold">
                <span id={labelId}>{row.label}</span>
                <Switch
                  checked={row.on}
                  onCheckedChange={(checked) => void toggle(row.key, checked)}
                  aria-labelledby={labelId}
                  aria-describedby={noteId}
                  aria-busy={saving.has(row.key) || undefined}
                  className="aria-busy:cursor-progress"
                />
              </div>
              {row.note ? (
                <p id={noteId} className="mb-0 mt-1 max-w-[46ch] text-[12.5px] leading-[1.45] text-ink-2">
                  {row.note}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mb-0 mt-2.5 text-[12.5px] text-ink-2">{NOTIFICATIONS_COPY.prefsNote}</p>
    </section>
  );
}
