"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { EmailPreferences } from "@/components/account/notifications/email-preferences";
import {
  appendPage,
  isPortalHref,
  markItemsRead,
  NOTIFICATIONS_COPY,
  notificationsHref,
  unreadTabLabel,
  visibleNotifications,
  type EmailPrefsView,
  type NotificationFilter,
  type NotificationItem,
} from "@/components/account/notifications/model";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { usePortal } from "@/components/account/portal-context";
import { notificationVisual, relativeTime } from "@/components/account/portal-nav";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { formatDateTimeIST } from "@/lib/dates";
import type { Tone } from "@/lib/design/tokens";
import { cn } from "@/lib/utils";

const TONE_TILE: Record<Tone, string> = {
  lavender: "bg-lavender-bg text-lavender-fg",
  sage: "bg-sage-bg text-sage-fg",
  blue: "bg-blue-bg text-blue-fg",
  peach: "bg-peach-bg text-peach-fg",
  pink: "bg-pink-bg text-pink-fg",
};

export type NotificationsPageData = {
  notifications: NotificationItem[];
  unread: number;
  nextCursor: string | null;
};

type ListResponse = NotificationsPageData;

const markRead = (ids?: string[]) =>
  apiFetch<{ updated: number; unread: number }>("/api/account/notifications/read", { method: "POST", body: ids ? { ids } : {} });

const ROW =
  "flex w-full items-start gap-3 p-3.5 text-left text-ink no-underline transition-colors hover:bg-lavender-soft hover:text-ink focus-visible:-outline-offset-2";

function NotificationRow({ item, now, onOpen }: { item: NotificationItem; now: Date; onOpen: (event: React.MouseEvent, item: NotificationItem) => void }) {
  const visual = notificationVisual(item.kind);
  const at = new Date(item.createdAt);
  const content = (
    <>
      <span aria-hidden="true" className={cn("grid size-[34px] flex-none place-items-center rounded-10", TONE_TILE[visual.tone])}>
        <Icon name={visual.icon} size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[14px]", item.read ? "font-semibold" : "font-extrabold")}>
          {item.title}
          {item.read ? null : <span className="sr-only">{NOTIFICATIONS_COPY.unreadSuffix}</span>}
        </span>
        {item.body ? <span className="mt-0.5 block text-[13.5px] text-ink-2">{item.body}</span> : null}
      </span>
      <time dateTime={item.createdAt} title={formatDateTimeIST(at)} className="shrink-0 whitespace-nowrap text-[12px] font-semibold text-ink-2">
        {relativeTime(at, now)}
      </time>
    </>
  );
  const rowClass = cn(ROW, !item.read && "bg-lavender-soft/50");
  return (
    <li className="border-b border-line-subtle last:border-b-0">
      {item.href ? (
        <a href={item.href} onClick={(event) => onOpen(event, item)} className={rowClass}>
          {content}
        </a>
      ) : (
        <button type="button" onClick={(event) => onOpen(event, item)} className={cn(rowClass, "cursor-pointer border-0 font-[inherit]")}>
          {content}
        </button>
      )}
    </li>
  );
}

/**
 * Notifications (prototype "Notifications"): "Mark all read", All / "Unread ({n})" filter (in the URL), the
 * notification rows (kind icon tile, bold title while unread, body, relative time; opening one marks it read and
 * follows its link), "Show more" for older ones, and the "Email preferences" card.
 */
export function NotificationsView({
  initial,
  prefs,
  filter,
  nowIso,
}: {
  initial: NotificationsPageData;
  prefs: EmailPrefsView;
  filter: NotificationFilter;
  nowIso: string;
}) {
  const router = useRouter();
  const { updateCounts } = usePortal();
  const [data, setData] = React.useState(initial);
  const [seen, setSeen] = React.useState(initial);
  const [shownFilter, setShownFilter] = React.useState(filter);
  const [seenFilter, setSeenFilter] = React.useState(filter);
  if (initial !== seen) {
    setSeen(initial);
    setData(initial);
  }
  if (filter !== seenFilter) {
    setSeenFilter(filter);
    setShownFilter(filter);
  }
  const [isPending, startTransition] = React.useTransition();
  const [marking, setMarking] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const listRef = React.useRef<HTMLUListElement>(null);
  const now = React.useMemo(() => new Date(nowIso), [nowIso]);
  const rows = visibleNotifications(data.notifications, shownFilter);

  function setUnread(unread: number) {
    setData((prev) => ({ ...prev, unread }));
    updateCounts({ notifications: unread });
  }

  function chooseFilter(next: NotificationFilter) {
    if (next === shownFilter) return;
    setShownFilter(next);
    startTransition(() => router.replace(notificationsHref(next), { scroll: false }));
  }

  async function markAll() {
    if (marking) return;
    setMarking(true);
    try {
      const res = await markRead();
      setData((prev) => ({ ...prev, notifications: markItemsRead(prev.notifications, undefined, new Date().toISOString()) }));
      setUnread(res.unread);
      toast.success(NOTIFICATIONS_COPY.markedAll);
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setMarking(false);
    }
  }

  async function open(event: React.MouseEvent, item: NotificationItem) {
    const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    const read = item.read
      ? Promise.resolve()
      : markRead([item.id]).then((res) => {
          setData((prev) => ({ ...prev, notifications: markItemsRead(prev.notifications, [item.id], new Date().toISOString()) }));
          setUnread(res.unread);
        });
    if (!item.href) {
      await read.catch((error: unknown) => toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE));
      return;
    }
    if (!plain) {
      // A new tab or window opens the link; this page stays and records the read.
      void read.catch(() => undefined);
      return;
    }
    event.preventDefault();
    if (isPortalHref(item.href)) {
      router.push(item.href);
      void read.catch(() => undefined);
    } else {
      // Order pages load in full (their own CSP): record the read first.
      await read.catch(() => undefined);
      window.location.assign(item.href);
    }
  }

  async function loadMore() {
    if (!data.nextCursor || loadingMore) return;
    setLoadingMore(true);
    const firstNew = rows.length;
    try {
      const params = new URLSearchParams({ cursor: data.nextCursor });
      if (shownFilter === "unread") params.set("filter", "unread");
      const page = await apiFetch<ListResponse>(`/api/account/notifications?${params.toString()}`);
      setData((prev) => ({ notifications: appendPage(prev.notifications, page.notifications), unread: page.unread, nextCursor: page.nextCursor }));
      updateCounts({ notifications: page.unread });
      // Keyboard users continue at the first newly loaded notification.
      window.requestAnimationFrame(() => listRef.current?.querySelectorAll<HTMLElement>("a, button")[firstNew]?.focus());
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setLoadingMore(false);
    }
  }

  const tabs: { value: NotificationFilter; label: string }[] = [
    { value: "all", label: NOTIFICATIONS_COPY.all },
    { value: "unread", label: unreadTabLabel(data.unread) },
  ];

  return (
    <>
      <PageHeader
        title={NOTIFICATIONS_COPY.title}
        description={NOTIFICATIONS_COPY.description}
        actions={
          <PageAction icon="done_all" onClick={() => void markAll()} busy={marking}>
            {NOTIFICATIONS_COPY.markAll}
          </PageAction>
        }
      />
      <div className="@container motion-safe:animate-enter-up">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] items-start gap-4">
          <section aria-label={NOTIFICATIONS_COPY.listLabel} className="min-w-0 overflow-hidden rounded-16 border border-line-alt bg-surface @min-[776px]:col-span-2">
            <div role="group" aria-label={NOTIFICATIONS_COPY.filterLabel} className="flex flex-wrap gap-1.5 border-b border-line-subtle px-3.5 py-2.5">
              {tabs.map((tab) => {
                const on = tab.value === shownFilter;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => chooseFilter(tab.value)}
                    className={cn(
                      "cursor-pointer rounded-8 border px-3 py-1.5 text-[13px] font-bold text-ink transition-colors",
                      on ? "border-primary-accent bg-lavender-bg" : "border-line-alt bg-surface hover:border-primary-accent",
                    )}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <div aria-busy={isPending || undefined} className={cn("transition-opacity", isPending && "opacity-60")}>
              {rows.length === 0 ? (
                <p className="m-0 p-8 text-center text-[14.5px] text-ink-2">{NOTIFICATIONS_COPY.empty}</p>
              ) : (
                <ul ref={listRef} className="m-0 list-none p-0">
                  {rows.map((item) => (
                    <NotificationRow key={item.id} item={item} now={now} onOpen={(event, n) => void open(event, n)} />
                  ))}
                </ul>
              )}
              {data.nextCursor ? (
                <div className="border-t border-line-subtle p-2.5 text-center">
                  <Button type="button" variant="secondary" size="sm" loading={loadingMore} onClick={() => void loadMore()} className="rounded-9">
                    {NOTIFICATIONS_COPY.showMore}
                  </Button>
                </div>
              ) : null}
            </div>
          </section>
          <EmailPreferences initial={prefs} />
        </div>
      </div>
    </>
  );
}
