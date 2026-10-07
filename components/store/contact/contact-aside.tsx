import Link from "next/link";
import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import { telHref } from "@/components/store/site-footer";
import { DEMO_STEPS, REACH_US } from "@/content/contact";
import type { BusinessSettings } from "@/lib/config";

type ReachRow = { icon: IconName; value: React.ReactNode; caption: React.ReactNode };

const VALUE_LINK = "font-bold text-ink no-underline transition-colors hover:text-primary-link hover:underline";

function ReachUsRow({ icon, value, caption }: ReachRow) {
  return (
    <li className="flex gap-3">
      <Icon name={icon} size={22} className="mt-px text-primary-link" />
      {/* anywhere (not break-word): long email addresses may wrap even inside auto-sized grid tracks. */}
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <div className="font-bold">{value}</div>
        <div className="text-[13.5px] text-ink-2">{caption}</div>
      </div>
    </li>
  );
}

/**
 * Contact page aside (Contact.dc.html): "What happens in a demo" and "Other ways to reach us", with the sales and
 * support addresses, phone and hours from settings.business. The placeholder note shows while the details are samples.
 * Server-safe; rendered once and passed into the client view.
 */
export function ContactAside({ business }: { business: BusinessSettings }) {
  const tel = business.sample ? null : telHref(business.phone);
  return (
    <>
      <section aria-labelledby="contact-demo-steps" className="rounded-22 bg-lavender-bg p-[22px]">
        <h2 id="contact-demo-steps" className="m-0 text-[17px] font-extrabold leading-[normal]">
          {DEMO_STEPS.title}
        </h2>
        <ol className="mb-0 mt-3 grid list-decimal gap-2 pl-5 text-[14.5px] leading-[1.55] text-ink-soft">
          {DEMO_STEPS.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="contact-reach-us" className="grid gap-3.5 rounded-22 border border-line bg-surface p-[22px]">
        <h2 id="contact-reach-us" className="m-0 text-[17px] font-extrabold leading-[normal]">
          {REACH_US.title}
        </h2>
        <ul className="m-0 grid list-none gap-3.5 p-0">
          <ReachUsRow
            icon="mail"
            value={
              <a href={`mailto:${business.salesEmail}`} className={VALUE_LINK}>
                {business.salesEmail}
              </a>
            }
            caption={REACH_US.salesCaption}
          />
          <ReachUsRow
            icon="support_agent"
            value={
              <a href={`mailto:${business.supportEmail}`} className={VALUE_LINK}>
                {business.supportEmail}
              </a>
            }
            caption={
              <>
                {REACH_US.supportCaptionBefore}
                <Link href={REACH_US.ticketHref} className="text-primary-link underline hover:text-primary-link-hover">
                  {REACH_US.supportCaptionLink}
                </Link>
              </>
            }
          />
          <ReachUsRow
            icon="call"
            value={
              tel ? (
                <a href={tel} className={VALUE_LINK}>
                  {business.phone}
                </a>
              ) : (
                business.phone
              )
            }
            caption={business.hours}
          />
        </ul>
        {business.sample ? (
          <p className="m-0 text-[12.5px] font-semibold text-ink-2">{REACH_US.sampleNote}</p>
        ) : null}
      </section>
    </>
  );
}
