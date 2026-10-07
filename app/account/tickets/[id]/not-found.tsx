import type { Metadata } from "next";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { PORTAL_PATHS } from "@/components/account/portal-nav";
import { TICKETS_COPY } from "@/components/account/tickets/model";
import { Icon } from "@/components/icons/icon";

export const metadata: Metadata = { title: TICKETS_COPY.notFoundTitle };

/** Prototype "Ticket not found" with the "All tickets" action (status 404). */
export default function TicketNotFound() {
  return (
    <>
      <PageHeader
        title={TICKETS_COPY.notFoundTitle}
        actions={
          <PageAction icon="arrow_back" href={PORTAL_PATHS.tickets}>
            {TICKETS_COPY.allTickets}
          </PageAction>
        }
      />
      <div className="rounded-16 border border-dashed border-line-input bg-surface px-6 py-12 text-center">
        <span aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-16 bg-lavender-bg text-lavender-fg">
          <Icon name="support_agent" size={28} />
        </span>
        <p className="mx-auto mb-0 mt-3.5 max-w-[440px] text-[14.5px] leading-[1.6] text-ink-2">{TICKETS_COPY.notFoundBody}</p>
      </div>
    </>
  );
}
