import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import type { InvoiceModel } from "@/lib/invoice/model";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";

export type InvoiceSummaryProps = {
  model: InvoiceModel;
  /** GET /api/orders/:id/invoice.pdf (with the order link token for guests). */
  pdfHref: string;
};

const OVERLINE = "text-xs font-extrabold tracking-[0.08em] text-ink-2";
const SMALL_BUTTON = "gap-1.5 rounded-10 px-3.5 py-2.5 text-[14px] leading-[normal]";

/**
 * "Order summary" / "Tax invoice {number}" card (Order.dc.html). Paid orders add SOLD BY / BILLED TO / INVOICE and
 * the print and PDF buttons; with the order page's print stylesheet this card is the printable invoice. A corrected
 * invoice also lists the model's notes ("This invoice replaces …, cancelled by credit note …"), as the PDF does.
 */
export function InvoiceSummary({ model, pdfHref }: InvoiceSummaryProps) {
  return (
    <section aria-labelledby="sum-h" className="mt-6 rounded-22 border border-line bg-surface p-6 print:break-inside-avoid">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="sum-h" className="text-lg font-extrabold">
          {model.title}
        </h2>
        <span className="text-sm font-semibold text-ink-2">{model.orderDateTime}</span>
      </div>
      {model.isInvoice ? (
        <div className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4 text-sm leading-[1.55]">
          <div>
            <div className={OVERLINE}>SOLD BY</div>
            {model.seller.name}
            <br />
            {model.seller.gstinLine}
            <br />
            {model.seller.location}
          </div>
          <div>
            <div className={OVERLINE}>BILLED TO</div>
            {model.buyer.name}
            <br />
            {model.buyer.addressLine}
            <br />
            {model.buyer.gstinLine}
          </div>
          <div>
            <div className={OVERLINE}>INVOICE</div>
            {model.number}
            <br />
            SAC {model.sac} · Place of supply: {model.placeOfSupply}
          </div>
        </div>
      ) : null}
      <ul className="mt-4 list-none border-t border-line-subtle p-0">
        {model.lines.map((line) => (
          <li key={line.index} className="flex justify-between gap-3 border-b border-line-subtle py-3 text-[15px]">
            <span>
              <strong className="font-bold">{line.shortName}</strong> · {line.detail}
            </span>
            <span className="font-bold whitespace-nowrap">{formatINR(line.grossPaise, { exact: true })}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-3.5 ml-auto grid max-w-[340px] grid-cols-[1fr_auto] gap-y-2 text-[14.5px]">
        {model.totals.map((row) => (
          <div key={row.key} className="contents">
            <dt className={cn("text-ink-2", row.strong ? "font-extrabold" : "font-semibold")}>{row.label}</dt>
            <dd className={cn("m-0 text-right", row.strong ? "font-extrabold" : "font-semibold")}>{row.display}</dd>
          </div>
        ))}
      </dl>
      {model.isInvoice && model.extraNotes.length > 0 ? (
        // A corrected invoice says which invoice it replaces (D18); kept in print, like the PDF.
        <ul className="mt-3.5 grid list-none gap-1 p-0 text-sm text-ink-2">
          {model.extraNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {model.isInvoice ? (
        <div className="mt-5 flex flex-wrap gap-2.5 border-t border-line-subtle pt-4 print:hidden">
          <Button type="button" variant="secondary" className={SMALL_BUTTON} onClick={() => window.print()}>
            <Icon name="print" size={18} />
            Print invoice
          </Button>
          <Button asChild variant="secondary" className={SMALL_BUTTON}>
            <a href={pdfHref} download>
              <Icon name="download" size={18} />
              Download PDF
            </a>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
