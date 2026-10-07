import { DashboardPanel } from "@/components/admin/overview/panel";
import { LICENSE_HEALTH_COLORS, toneBar } from "@/components/admin/overview/chart-colors";
import { TONE_BG, TONE_FG } from "@/components/admin/overview/kpi-cards";
import {
  creditNoteCount,
  durationText,
  REPORTS_COPY,
  type GstMonthRow,
  type ProductHealthRow,
  type ProductSalesRow,
  type ReportExportKey,
  type ReportsData,
  type SalesMonthRow,
  type SupportAssigneeRow,
} from "@/lib/admin/reports/model";
import { LICENSE_HEALTH_ROWS } from "@/lib/admin/overview/model";
import { LICENSE_STATUS_META } from "@/lib/licensing/status";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ReportExportButton } from "./export-button";
import { ReportTable, type ReportColumn } from "./report-table";

/** Report amounts always show paise, so columns line up and totals read exactly. */
const inr = (paise: number) => formatINR(paise, { exact: true });
const n = (value: number) => value.toLocaleString("en-IN");

function CsvButton({ report, data }: { report: ReportExportKey; data: ReportsData }) {
  return <ReportExportButton report={report} range={data.range} label="CSV" size="xs" />;
}

const SALES_COLUMNS: readonly ReportColumn<SalesMonthRow>[] = [
  { key: "month", header: "Month", cell: (r) => r.label },
  { key: "invoices", header: "Invoices", align: "right", cell: (r) => n(r.invoices) },
  { key: "taxable", header: "Taxable", align: "right", cell: (r) => inr(r.taxablePaise) },
  { key: "gst", header: "GST", align: "right", cell: (r) => inr(r.gstPaise) },
  {
    key: "credit",
    header: "Credit notes",
    align: "right",
    cell: (r) => (
      <>
        {inr(r.creditTaxablePaise)}
        {r.creditNotes > 0 ? <span className="block text-[11.5px] font-semibold text-ink-2">{creditNoteCount(r.creditNotes)}</span> : null}
      </>
    ),
  },
  { key: "net", header: "Net taxable", align: "right", cell: (r) => inr(r.netTaxablePaise) },
];

/** Invoices issued per IST month: taxable value, GST, credit notes (taxable) and the net taxable value. */
export function SalesByMonthPanel({ data }: { data: ReportsData }) {
  return (
    <DashboardPanel id="rp-sales-month" title={REPORTS_COPY.salesByMonth} wide aside={<CsvButton report="sales-by-month" data={data} />}>
      <ReportTable
        caption={`${REPORTS_COPY.salesByMonth}, ${data.scope}`}
        columns={SALES_COLUMNS}
        rows={data.salesByMonth.rows}
        rowKey={(r) => r.key}
        footer={data.salesByMonth.total}
      />
    </DashboardPanel>
  );
}

const PRODUCT_COLUMNS: readonly ReportColumn<ProductSalesRow>[] = [
  {
    key: "product",
    header: "Product",
    cell: (r) =>
      r.productId === "total" ? (
        r.name
      ) : (
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm forced-color-adjust-none" style={{ background: toneBar(r.tone) }} />
          {r.name}
        </span>
      ),
  },
  { key: "orders", header: "Orders", align: "right", cell: (r) => n(r.orders) },
  { key: "taxable", header: "Taxable", align: "right", cell: (r) => inr(r.taxablePaise) },
  { key: "credit", header: "Credit notes", align: "right", cell: (r) => inr(r.creditPaise) },
  { key: "net", header: "Net taxable", align: "right", cell: (r) => inr(r.netPaise) },
];

/** Invoiced line values per product with credit notes, highest net first. */
export function SalesByProductPanel({ data }: { data: ReportsData }) {
  return (
    <DashboardPanel id="rp-sales-product" title={REPORTS_COPY.salesByProduct} wide aside={<CsvButton report="sales-by-product" data={data} />}>
      <ReportTable
        caption={`${REPORTS_COPY.salesByProduct}, ${data.scope}`}
        columns={PRODUCT_COLUMNS}
        rows={data.salesByProduct.rows}
        rowKey={(r) => r.productId}
        footer={data.salesByProduct.rows.length > 0 ? data.salesByProduct.total : undefined}
        empty={REPORTS_COPY.noInvoices}
      />
    </DashboardPanel>
  );
}

function gstColumns(countHeader: string): ReportColumn<GstMonthRow>[] {
  return [
    { key: "month", header: "Month", cell: (r) => r.label },
    { key: "count", header: countHeader, align: "right", cell: (r) => n(r.count) },
    { key: "taxable", header: "Taxable", align: "right", cell: (r) => inr(r.taxablePaise) },
    { key: "cgst", header: "CGST", align: "right", cell: (r) => inr(r.cgstPaise) },
    { key: "sgst", header: "SGST", align: "right", cell: (r) => inr(r.sgstPaise) },
    { key: "igst", header: "IGST", align: "right", cell: (r) => inr(r.igstPaise) },
    { key: "tax", header: "Total tax", align: "right", cell: (r) => inr(r.taxPaise) },
    { key: "value", header: "Total", align: "right", cell: (r) => inr(r.valuePaise) },
  ];
}
const GST_INVOICE_COLUMNS = gstColumns("Invoices");
const GST_CREDIT_COLUMNS = gstColumns("Notes");

/** Tax invoices per month (for GSTR-1 preparation), credit notes apart, and the net tax after credit notes. */
export function GstPanel({ data }: { data: ReportsData }) {
  const g = data.gstByMonth;
  return (
    <DashboardPanel id="rp-gst" title={REPORTS_COPY.gstByMonth} wide aside={<CsvButton report="gst-by-month" data={data} />}>
      <ReportTable
        caption={`Tax invoices by month, ${data.scope}`}
        columns={GST_INVOICE_COLUMNS}
        rows={g.invoices}
        rowKey={(r) => r.key}
        footer={g.invoiceTotal}
      />
      <h3 id="rp-gst-credit" className="m-0 border-t border-line-alt px-4 pb-1 pt-3 text-[13px] font-extrabold">
        {REPORTS_COPY.creditNotes}
      </h3>
      <ReportTable
        caption={`Credit notes by month, ${data.scope}`}
        columns={GST_CREDIT_COLUMNS}
        rows={g.creditNotes}
        rowKey={(r) => r.key}
        footer={g.creditNotes.length > 0 ? g.creditTotal : undefined}
        empty={REPORTS_COPY.noCreditNotes}
      />
      <p className="m-0 flex flex-wrap justify-between gap-2 border-t border-line-alt px-4 py-3 text-[13px] font-semibold text-ink-2">
        <span>GST on invoices less credit notes</span>
        <strong className="text-ink tabular-nums">{inr(g.netTaxPaise)}</strong>
      </p>
    </DashboardPanel>
  );
}

/** Status order of the Overview's license health (prototype): active, expiring, trial, expired, suspended, revoked. */
const HEALTH_ORDER = LICENSE_HEALTH_ROWS.map((r) => r.key);

const HEALTH_COLUMNS: readonly ReportColumn<ProductHealthRow>[] = [
  { key: "product", header: "Product", cell: (r) => r.name },
  ...HEALTH_ORDER.map(
    (status): ReportColumn<ProductHealthRow> => ({
      key: status,
      label: LICENSE_STATUS_META[status].adminLabel,
      header: (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-sm forced-color-adjust-none" style={{ background: LICENSE_HEALTH_COLORS[status] }} />
          {LICENSE_STATUS_META[status].adminLabel}
        </span>
      ),
      align: "right",
      cell: (r) => n(r.counts[status]),
    }),
  ),
  { key: "total", header: "Total", align: "right", cell: (r) => n(r.total) },
];

/** Licenses per product by derived status today, with the overall split as a stacked bar. */
export function LicenseHealthReport({ data }: { data: ReportsData }) {
  const h = data.licenseHealth;
  const segments = HEALTH_ORDER.filter((s) => h.counts[s] > 0);
  const total: ProductHealthRow = { productId: "total", name: "Total", counts: h.counts, total: h.total };
  return (
    <DashboardPanel id="rp-licenses" title={REPORTS_COPY.licenseHealth} wide aside={<CsvButton report="license-health" data={data} />}>
      {h.total > 0 ? (
        <div className="px-4 pb-1 pt-4">
          <div
            role="img"
            aria-label={`Licenses today: ${segments.map((s) => `${LICENSE_STATUS_META[s].adminLabel} ${n(h.counts[s])}`).join(", ")}.`}
            className="flex h-3.5 gap-0.5 overflow-hidden rounded-pill forced-color-adjust-none"
          >
            {segments.map((s) => (
              <span key={s} style={{ flex: `${h.counts[s]} 1 0%`, background: LICENSE_HEALTH_COLORS[s] }} />
            ))}
          </div>
        </div>
      ) : null}
      <ReportTable
        caption="Licenses per product by status today"
        columns={HEALTH_COLUMNS}
        rows={h.byProduct}
        rowKey={(r) => r.productId}
        footer={h.byProduct.length > 0 ? total : undefined}
        empty={REPORTS_COPY.noLicenses}
      />
    </DashboardPanel>
  );
}

const SUPPORT_COLUMNS: readonly ReportColumn<SupportAssigneeRow>[] = [
  { key: "name", header: "Assignee", cell: (r) => r.name },
  { key: "role", header: "Role", cell: (r) => (r.id === "total" ? "" : r.role || "\u2014") },
  { key: "open", header: "Waiting on us", align: "right", cell: (r) => n(r.open) },
  { key: "awaiting", header: "Waiting on customer", align: "right", cell: (r) => n(r.awaitingCustomer) },
  { key: "high", header: "High priority", align: "right", cell: (r) => n(r.high) },
  { key: "resolved", header: "Resolved in period", align: "right", cell: (r) => n(r.resolved) },
];

/** Tickets opened and resolved in the range, the median first response, open tickets today per assignee. */
export function SupportReport({ data }: { data: ReportsData }) {
  const s = data.support;
  const tiles = [
    { label: "Opened in period", value: n(s.opened), tone: "lavender" as const },
    { label: "Resolved in period", value: n(s.resolved), tone: "sage" as const },
    { label: "Median first response", value: durationText(s.medianFirstResponseMinutes), tone: "lavender" as const },
    { label: "Waiting on us", value: n(s.waitingOnUs), tone: "blue" as const },
    { label: "Waiting on customer", value: n(s.waitingOnCustomer), tone: "peach" as const },
    { label: "High priority", value: n(s.highPriority), tone: "pink" as const },
  ];
  const total: SupportAssigneeRow = {
    id: "total",
    name: "Total",
    role: "",
    open: s.waitingOnUs,
    awaitingCustomer: s.waitingOnCustomer,
    high: s.highPriority,
    resolved: s.resolved,
  };
  return (
    <DashboardPanel id="rp-support" title={REPORTS_COPY.support} wide aside={<CsvButton report="support-workload" data={data} />}>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] gap-2 px-4 py-3.5">
        {tiles.map((t) => (
          <div key={t.label} className={cn("flex flex-col-reverse justify-end rounded-10 p-2.5", TONE_BG[t.tone])}>
            <dt className="text-[12px] font-bold leading-[normal] text-ink-soft">{t.label}</dt>
            <dd className={cn("m-0 text-[20px] font-extrabold leading-[normal] tabular-nums", TONE_FG[t.tone])}>{t.value}</dd>
          </div>
        ))}
      </dl>
      <ReportTable
        caption="Open tickets per assignee today and tickets resolved in the period"
        columns={SUPPORT_COLUMNS}
        rows={s.assignees}
        rowKey={(r) => r.id ?? "unassigned"}
        footer={total}
        className="border-t border-line-subtle"
      />
    </DashboardPanel>
  );
}
