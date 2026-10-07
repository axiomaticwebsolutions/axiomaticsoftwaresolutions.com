import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { Container } from "@/components/store/container";
import { GST_COPY, MAINTENANCE_COPY, PAYMENT_COPY, type MaintenanceValues } from "@/content/pricing";
import { formatINR } from "@/lib/money";
import { formatRate, halfRate, type GstExample } from "./pricing-model";

export type MaintenanceGstProps = {
  maintenance: MaintenanceValues;
  /** settings tax.gstRatePct */
  ratePct: number;
  /** Worked example from lib/pricing quote(); the breakdown is left out when nothing is for sale. */
  example: GstExample | null;
};

const MAINTENANCE_HEADING_ID = "maintenance-heading";
const PAYMENTS_HEADING_ID = "payments-heading";
const CARD_HEADING = "m-0 text-[clamp(24px,2.6vw,32px)] font-extrabold leading-[normal] tracking-[-0.03em]";
const CARD_BODY = "mb-0 mt-3 text-[16px] leading-[1.65] text-ink-soft";
const SMALL_HEADING = "m-0 text-[22px] font-extrabold leading-[normal] tracking-[-0.02em]";

/** Exact rupees, as the prototype's example (₹4,999.00 / ₹899.82 / ₹5,898.82). */
function exact(paise: number): string {
  return formatINR(paise, { exact: true });
}

function ExampleBreakdown({ example }: { example: GstExample }) {
  const rate = formatRate(example.ratePct);
  return (
    <dl className="mb-0 mt-[18px] grid grid-cols-[1fr_auto] gap-y-2 rounded-16 bg-surface px-[18px] py-4 text-[15px] leading-[normal]">
      <dt className="pr-4 font-semibold text-ink-2">{GST_COPY.exampleLabel(example.planName)}</dt>
      <dd className="m-0 font-bold tabular">{exact(example.basePaise)}</dd>
      <dt className="pr-4 font-semibold text-ink-2">{GST_COPY.gstLabel(rate)}</dt>
      <dd className="m-0 font-bold tabular">{exact(example.gstPaise)}</dd>
      <dt className="border-t border-line-subtle pr-4 pt-2 font-extrabold">{GST_COPY.totalLabel}</dt>
      <dd className="m-0 border-t border-line-subtle pt-2 font-extrabold tabular">{exact(example.totalPaise)}</dd>
    </dl>
  );
}

/**
 * #maintenance: the peach "Maintenance & support plans" card and the blue "How GST is charged" card with a worked
 * example, then a payments and refunds card (not in the prototype; see content/pricing.ts).
 */
export function MaintenanceGst({ maintenance, ratePct, example }: MaintenanceGstProps) {
  const rate = formatRate(ratePct);
  return (
    <Container className="py-[clamp(48px,6vw,80px)]">
      <section
        id="maintenance"
        aria-labelledby={MAINTENANCE_HEADING_ID}
        className="grid scroll-mt-2.5 grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] gap-5"
      >
        <div className="rounded-[26px] bg-peach-bg p-[clamp(24px,4vw,40px)]">
          <h2 id={MAINTENANCE_HEADING_ID} className={CARD_HEADING}>
            {MAINTENANCE_COPY.heading}
          </h2>
          <p className={CARD_BODY}>{MAINTENANCE_COPY.body(maintenance)}</p>
          <ul className="mb-0 mt-[18px] grid list-none gap-2.5 p-0 text-[15px] font-bold leading-6">
            {MAINTENANCE_COPY.bullets.map((item) => (
              <li key={item} className="flex gap-2.5">
                <Icon name="check" size={20} className="mt-0.5 text-peach-fg" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-[26px] bg-blue-bg p-[clamp(24px,4vw,40px)]">
          <h2 className={CARD_HEADING}>{GST_COPY.heading}</h2>
          <p className={CARD_BODY}>{GST_COPY.body(rate, halfRate(ratePct))}</p>
          {example ? <ExampleBreakdown example={example} /> : null}
          <p className="mb-0 mt-2.5 text-[13px] leading-[normal] text-ink-2">{GST_COPY.note}</p>
        </div>
      </section>

      <section
        aria-labelledby={PAYMENTS_HEADING_ID}
        className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] gap-x-10 gap-y-7 rounded-[26px] border border-line bg-surface p-[clamp(24px,4vw,40px)]"
      >
        <div>
          <h2 id={PAYMENTS_HEADING_ID} className={SMALL_HEADING}>
            {PAYMENT_COPY.heading}
          </h2>
          <p className="mb-0 mt-2.5 text-[15.5px] leading-[1.6] text-ink-soft">{PAYMENT_COPY.body}</p>
          <ul className="mb-0 mt-4 flex list-none flex-wrap gap-2.5 p-0 leading-[normal]">
            {PAYMENT_COPY.methods.map((method) => (
              <li key={method.label} className="flex items-center gap-2.5 rounded-14 border border-line py-2 pl-2 pr-3.5">
                <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-10 bg-lavender-bg text-lavender-fg">
                  <Icon name={method.icon} size={20} />
                </span>
                <span>
                  <span className="block text-[14.5px] font-bold">{method.label}</span>
                  <span className="block text-[13px] font-semibold text-ink-2">{method.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className={SMALL_HEADING}>{PAYMENT_COPY.refundHeading}</h2>
          <p className="mb-0 mt-2.5 text-[15.5px] leading-[1.6] text-ink-soft">{PAYMENT_COPY.refundBody}</p>
          <Link
            href={PAYMENT_COPY.refundLink.href}
            className="mt-3 inline-flex items-center gap-1.5 rounded-6 font-bold text-primary-link hover:text-primary-link-hover"
          >
            {PAYMENT_COPY.refundLink.label}
            <Icon name="arrow_forward" size={18} />
          </Link>
        </div>
      </section>
    </Container>
  );
}
