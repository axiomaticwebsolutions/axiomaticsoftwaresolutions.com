import { Icon } from "@/components/icons/icon";
import { TONE_BG, TONE_FG } from "@/components/admin/overview/kpi-cards";
import { PanelGrid } from "@/components/admin/overview/panel";
import { RangeScope } from "@/components/admin/overview/range-scope";
import { RANGE_META } from "@/lib/admin/overview/range";
import { REPORT_CARD_KEYS, REPORT_EXPORTS, reportCardMeta, reportsNote, type ReportsData } from "@/lib/admin/reports/model";
import { GstPanel, LicenseHealthReport, SalesByMonthPanel, SalesByProductPanel, SupportReport } from "./report-panels";
import { ReportExportButton } from "./export-button";

/** The prototype's six export cards (auto-fit at 300px): tone icon, title, description, scope line, Export CSV. */
function ExportCards({ data }: { data: ReportsData }) {
  const last = RANGE_META[data.range].lastLabel;
  return (
    <ul aria-label="Exports" className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3.5 p-0">
      {REPORT_CARD_KEYS.map((key) => {
        const meta = REPORT_EXPORTS[key];
        return (
          <li key={key} className="flex min-w-0 flex-col gap-2 rounded-14 border border-line-alt bg-surface p-4">
            <span aria-hidden="true" className={`grid size-9 place-items-center rounded-10 ${TONE_BG[meta.tone]} ${TONE_FG[meta.tone]}`}>
              <Icon name={meta.icon} size={20} />
            </span>
            <h2 className="mb-0 mt-1 text-[15px] font-extrabold leading-[normal]">{meta.title}</h2>
            <p className="m-0 flex-1 text-[13px] leading-[1.55] text-ink-2">{meta.description}</p>
            <p className="m-0 text-[12px] font-bold text-ink-2">{reportCardMeta(meta.scope, last, data.sample)}</p>
            <ReportExportButton report={key} range={data.range} className="mt-1 h-9 w-full" />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Reports & exports (Admin Console.dc.html #reports plus the decisions.md Phase 6 reports): the date range, the six
 * export cards, then sales by month and by product, the GST summary by month with credit notes apart, license health
 * and the support workload, each with its own CSV export.
 */
export function ReportsView({ data }: { data: ReportsData }) {
  return (
    <RangeScope range={data.range} note={reportsNote(data.scope, data.sample)}>
      <ExportCards data={data} />
      <PanelGrid>
        <SalesByMonthPanel data={data} />
        <SalesByProductPanel data={data} />
        <GstPanel data={data} />
        <LicenseHealthReport data={data} />
        <SupportReport data={data} />
      </PanelGrid>
    </RangeScope>
  );
}
