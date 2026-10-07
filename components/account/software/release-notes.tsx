import { ScrollRegion } from "@/components/ui/scroll-region";
import { cn } from "@/lib/utils";
import type { SoftwareReleaseView } from "@/lib/software/view";
import { releaseRows, SOFTWARE_COPY, type ReleaseRow } from "./model";

const ACCESS_PILL: Record<ReleaseRow["access"], string> = {
  included: "bg-sage-bg text-sage-fg",
  needs_renewal: "bg-peach-bg text-peach-fg",
};

function AccessPill({ row }: { row: ReleaseRow }) {
  return (
    <span className={cn("whitespace-nowrap rounded-pill px-2 py-0.5 text-[11.5px] font-extrabold", ACCESS_PILL[row.access])}>
      {row.accessLabel}
    </span>
  );
}

/**
 * Collapsible release notes of one product (prototype table: VERSION, RELEASED, CHANGES, YOUR ACCESS with "Included" /
 * "Needs renewal"). Below 760px the rows become stacked cards (README "tables become cards"). Server-safe markup.
 */
export function ReleaseNotes({
  id,
  hidden,
  productName,
  releases,
}: {
  id: string;
  hidden: boolean;
  productName: string;
  releases: readonly SoftwareReleaseView[];
}) {
  const rows = releaseRows(releases);
  return (
    <div id={id} hidden={hidden}>
      {/* Scrolls inside the card, never the page, when the columns do not fit (zoom, text spacing). */}
      <ScrollRegion label={`${SOFTWARE_COPY.releaseNotes} for ${productName}`} className="hidden cards:block">
        <table className="w-full border-collapse text-[13.5px]">
          <caption className="sr-only">{`${SOFTWARE_COPY.releaseNotes} for ${productName}`}</caption>
          <thead>
            <tr className="bg-bg text-left text-[11.5px] uppercase tracking-[0.06em] text-ink-2">
              <th scope="col" className="px-[18px] py-[9px] font-extrabold">
                {SOFTWARE_COPY.version}
              </th>
              <th scope="col" className="px-3 py-[9px] font-extrabold">
                {SOFTWARE_COPY.released}
              </th>
              <th scope="col" className="px-3 py-[9px] font-extrabold">
                {SOFTWARE_COPY.changes}
              </th>
              <th scope="col" className="px-[18px] py-[9px] font-extrabold">
                {SOFTWARE_COPY.access}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-line-subtle align-top">
                <th scope="row" className="px-[18px] py-2.5 text-left font-extrabold">
                  {row.version}
                </th>
                <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-ink-2">
                  <time dateTime={row.dateTime}>{row.date}</time>
                </td>
                <td className="px-3 py-2.5">{row.changes}</td>
                <td className="px-[18px] py-2.5">
                  <AccessPill row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <ul aria-label={`${SOFTWARE_COPY.releaseNotes} for ${productName}`} className="m-0 list-none p-0 cards:hidden">
        {rows.map((row) => (
          <li key={row.id} className="grid gap-1 border-t border-line-subtle px-[18px] py-3 text-[13.5px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-extrabold">{row.version}</span>{" "}
                <time dateTime={row.dateTime} className="font-semibold text-ink-2">
                  {`\u00b7 ${row.date}`}
                </time>
              </span>
              <AccessPill row={row} />
            </div>
            <p className="m-0">{row.changes}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
