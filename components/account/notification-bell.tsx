"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { usePortal } from "@/components/account/portal-context";
import {
  normalizeNotifications,
  notificationsLabel,
  notificationVisual,
  PORTAL_BASE,
  PORTAL_PATHS,
  relativeTime,
  type PortalNotification,
} from "@/components/account/portal-nav";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/design/tokens";

/** Rows shown in the menu; the Notifications page has the rest. */
export const BELL_LIMIT = 6;

const TONE_TILE: Record<Tone, string> = {
  lavender: "bg-lavender-bg text-lavender-fg",
  sage: "bg-sage-bg text-sage-fg",
  blue: "bg-blue-bg text-blue-fg",
  peach: "bg-peach-bg text-peach-fg",
  pink: "bg-pink-bg text-pink-fg",
};

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; items: PortalNotification[] };

const markRead = (ids?: string[]) =>
  apiFetch<unknown>("/api/account/notifications/read", { method: "POST", body: ids ? { ids } : {} });

/**
 * Top-bar bell (prototype: icon with an 8px pink dot when anything is unread, labelled "Notifications, {n} unread").
 * Opens a menu with the latest notifications (GET /api/account/notifications), "Mark all as read" and a link to the
 * Notifications page. Opening a notification marks it read.
 */
export function NotificationBell() {
  const router = useRouter();
  const { counts, updateCounts } = usePortal();
  const unread = counts.notifications;
  const [open, setOpen] = React.useState(false);
  const [load, setLoad] = React.useState<Load>({ status: "loading" });
  const [marking, setMarking] = React.useState(false);
  const viewAllRef = React.useRef<HTMLAnchorElement>(null);
  // Read through a ref: a server re-render (router.refresh) gives updateCounts a new identity, which must not refetch.
  const updateRef = React.useRef(updateCounts);
  React.useEffect(() => {
    updateRef.current = updateCounts;
  });

  const fetchList = React.useCallback(async (signal?: AbortSignal) => {
    setLoad({ status: "loading" });
    try {
      const body = await apiFetch<unknown>("/api/account/notifications", { signal });
      const { items, unread: serverUnread } = normalizeNotifications(body);
      setLoad({ status: "ready", items: items.slice(0, BELL_LIMIT) });
      if (serverUnread !== null) updateRef.current({ notifications: serverUnread });
    } catch {
      if (!signal?.aborted) setLoad({ status: "error" });
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetchList(controller.signal);
    return () => controller.abort();
  }, [open, fetchList]);

  async function markAll() {
    if (marking) return;
    setMarking(true);
    try {
      await markRead();
      updateCounts({ notifications: 0 });
      setLoad((prev) => (prev.status === "ready" ? { status: "ready", items: prev.items.map((n) => ({ ...n, read: true })) } : prev));
      // The button disappears with the last unread item: keep keyboard focus inside the menu.
      viewAllRef.current?.focus();
      toast.success("All marked as read");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setMarking(false);
    }
  }

  async function openNotification(event: React.MouseEvent<HTMLAnchorElement>, item: PortalNotification) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setOpen(false);
    const href = item.href ?? PORTAL_PATHS.notifications;
    const read = item.read ? Promise.resolve() : markRead([item.id]).then(() => updateCounts({ notifications: Math.max(0, unread - 1) }));
    if (href.startsWith(PORTAL_BASE)) {
      router.push(href);
      void read.catch(() => undefined);
    } else {
      // A full page load (order pages carry their own CSP): record the read first.
      await read.catch(() => undefined);
      window.location.assign(href);
    }
  }

  const now = new Date();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={notificationsLabel(unread)}
          className="relative grid size-[38px] shrink-0 cursor-pointer place-items-center rounded-10 border-0 bg-transparent text-ink-2 transition-colors hover:bg-slate-bg hover:text-ink data-[state=open]:bg-slate-bg"
        >
          <Icon name="notifications" size={21} />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute right-2 top-[7px] size-2 rounded-pill border-2 border-surface bg-danger-border"
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-label="Notifications"
        className="w-[360px] max-w-[calc(100vw-24px)] rounded-14 border-line-alt p-0 leading-[normal]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-4 py-3">
          <h2 className="m-0 text-[15px] font-extrabold">Notifications</h2>
          {unread > 0 ? (
            <button
              type="button"
              onClick={() => void markAll()}
              aria-busy={marking || undefined}
              className="inline-flex cursor-pointer items-center gap-1 rounded-6 border-0 bg-transparent p-0 text-[13px] font-bold text-primary-link hover:text-primary-link-hover aria-busy:cursor-progress"
            >
              <Icon name="done_all" size={17} />
              Mark all as read
            </button>
          ) : null}
        </div>
        <div className="max-h-[min(380px,60dvh)] overflow-y-auto" aria-busy={load.status === "loading" || undefined}>
          {load.status === "loading" ? (
            <div className="grid gap-3 p-4">
              <span className="sr-only">Loading notifications</span>
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="size-[34px] flex-none rounded-10" />
                  <div className="grid flex-1 gap-2 pt-1">
                    <Skeleton className="h-3.5 w-3/5" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : load.status === "error" ? (
            <div role="alert" className="grid justify-items-center gap-2 px-4 py-6 text-center text-[14px] text-ink-2">
              <p className="m-0">We couldn’t load notifications.</p>
              <button
                type="button"
                onClick={() => void fetchList()}
                className="cursor-pointer rounded-6 border-0 bg-transparent p-0 font-bold text-primary-link hover:text-primary-link-hover"
              >
                Try again
              </button>
            </div>
          ) : load.items.length === 0 ? (
            <p className="m-0 px-4 py-8 text-center text-[14px] text-ink-2">You’re all caught up.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {load.items.map((item) => {
                const visual = notificationVisual(item.kind);
                return (
                  <li key={item.id} className="border-b border-line-subtle last:border-b-0">
                    <a
                      href={item.href ?? PORTAL_PATHS.notifications}
                      onClick={(event) => void openNotification(event, item)}
                      className={cn(
                        "flex items-start gap-3 px-4 py-3 text-ink no-underline transition-colors hover:bg-lavender-soft hover:text-ink",
                        !item.read && "bg-lavender-soft/60",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn("grid size-[34px] flex-none place-items-center rounded-10", TONE_TILE[visual.tone])}
                      >
                        <Icon name={visual.icon} size={19} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-[14px]", item.read ? "font-semibold" : "font-extrabold")}>
                          {item.title}
                          {item.read ? null : <span className="sr-only"> (unread)</span>}
                        </span>
                        {item.body ? (
                          <span className="mt-0.5 line-clamp-2 block text-[13px] text-ink-2">{item.body}</span>
                        ) : null}
                      </span>
                      {item.createdAt ? (
                        <span className="shrink-0 whitespace-nowrap text-[12px] font-semibold text-ink-2">
                          {relativeTime(item.createdAt, now)}
                        </span>
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="border-t border-line-subtle p-2">
          <Link
            ref={viewAllRef}
            href={PORTAL_PATHS.notifications}
            onClick={() => setOpen(false)}
            className="block rounded-9 p-2 text-center text-[13.5px] font-bold text-primary-link no-underline transition-colors hover:bg-lavender-soft hover:text-primary-link-hover"
          >
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
