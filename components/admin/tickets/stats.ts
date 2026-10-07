/**
 * Stats row of /admin/tickets. Server-safe and pure (unit tested).
 */
import type { AdminStat } from "@/components/admin/stats-row";
import { formatDuration, FIRST_RESPONSE_WINDOW_DAYS } from "@/lib/admin/tickets/model";
import type { AdminTicketStats } from "@/lib/admin/tickets/service";

export type TicketStatsRowInput = Pick<AdminTicketStats, "open" | "unassigned" | "highPriority" | "firstResponseMedianMs" | "firstResponseSample"> & {
  /** Tickets shown as Resolved (RESOLVED, not yet closed at the 14-day mark): the "Resolved" status filter's count. */
  resolved: number;
};

function count(n: number): string {
  return n.toLocaleString("en-IN");
}

/**
 * The prototype's cards (Admin Console.dc.html #tickets: OPEN blue, UNASSIGNED peach, HIGH PRIORITY pink, RESOLVED
 * sage; unassigned and high priority count open or awaiting-customer tickets), then the median FIRST RESPONSE
 * (decisions.md Phase 6 "Tickets").
 */
export function ticketStatsRow(stats: TicketStatsRowInput): AdminStat[] {
  const median = stats.firstResponseMedianMs;
  return [
    { label: "Open", value: count(stats.open), tone: "blue" },
    { label: "Unassigned", value: count(stats.unassigned), tone: "peach" },
    { label: "High priority", value: count(stats.highPriority), tone: "pink" },
    { label: "Resolved", value: count(stats.resolved), tone: "sage" },
    {
      label: "First response",
      value: median === null ? "\u2014" : formatDuration(median),
      tone: "lavender",
      delta:
        median === null
          ? `No replies in the last ${FIRST_RESPONSE_WINDOW_DAYS} days`
          : `Median of ${count(stats.firstResponseSample)} in the last ${FIRST_RESPONSE_WINDOW_DAYS} days`,
    },
  ];
}
