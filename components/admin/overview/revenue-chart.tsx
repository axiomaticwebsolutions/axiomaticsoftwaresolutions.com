import { revenueChartLabel, rupeesWhole, type OverviewData } from "@/lib/admin/overview/model";
import { cn } from "@/lib/utils";
import { REVENUE_BAR } from "./chart-colors";

export type RevenueChartProps = { revenue: OverviewData["revenue"]; range: OverviewData["range"] };

/** Where a bar's tooltip sits so it never leaves the chart: start, middle or end of the row of bars. */
function tooltipAlign(i: number, n: number): string {
  if (i < n / 4) return "left-0";
  if (i >= (3 * n) / 4) return "right-0";
  return "left-1/2 -translate-x-1/2";
}

/**
 * Revenue bar chart (Admin Console.dc.html): 180px of bars, one per day (7d, 30d), week (90d) or month (12m), the
 * latest bar in primary and the rest in the light accent, empty buckets as 2px stubs, four axis ticks. Hovering a
 * column shows "{date}: ₹x" (the whole column is the hit area). The bars are hidden from assistive technology; a
 * visually hidden table carries the same figures, captioned with the prototype's chart description. Server-safe.
 */
export function RevenueChart({ revenue, range }: RevenueChartProps) {
  const { bars, ticks } = revenue;
  const max = Math.max(1, ...bars.map((b) => b.paise));
  const label = revenueChartLabel(range, revenue.totalPaise, revenue.peakPaise, revenue.unit);
  return (
    <div className="p-4">
      <div aria-hidden="true" className={cn("relative flex h-[180px] items-end border-b border-line-alt forced-color-adjust-none", bars.length > 20 ? "gap-0.5" : "gap-1.5")}>
        {bars.map((bar, i) => {
          const pct = (Math.max(0, bar.paise) / max) * 100;
          const latest = i === bars.length - 1;
          return (
            <div key={bar.key} className="group relative flex h-full min-w-0 flex-1 items-end">
              <div
                className="min-h-[2px] w-full rounded-t transition-opacity group-hover:opacity-80"
                style={{ height: `${pct}%`, background: latest ? REVENUE_BAR.current : REVENUE_BAR.past }}
              />
              <div
                className={cn(
                  "pointer-events-none absolute z-10 hidden whitespace-nowrap rounded-8 bg-ink px-2 py-1 text-[11.5px] font-bold leading-[normal] text-white shadow-toast group-hover:block",
                  tooltipAlign(i, bars.length),
                )}
                style={{ bottom: `calc(${pct}% + 6px)` }}
              >
                {bar.title}: {rupeesWhole(bar.paise)}
              </div>
            </div>
          );
        })}
      </div>
      <div aria-hidden="true" className="mt-1.5 flex justify-between gap-2 text-[11px] font-bold text-ink-3">
        {ticks.map((tick, i) => (
          <span key={`${i}:${tick}`}>{tick}</span>
        ))}
      </div>
      {/* sr-only on a wrapper: a table ignores width: 1px and would widen the page. */}
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{revenue.unit === "month" ? "Month" : revenue.unit === "week" ? "Week" : "Day"}</th>
              <th scope="col">Revenue excluding GST</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((bar) => (
              <tr key={bar.key}>
                <th scope="row">{bar.title}</th>
                <td>{rupeesWhole(bar.paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
