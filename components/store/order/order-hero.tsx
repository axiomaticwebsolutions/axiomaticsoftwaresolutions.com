import Link from "next/link";
import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HERO_TONE_CLASSES, type HeroAction, type HeroView } from "./order-model";

export type OrderHeroProps = {
  orderId: string;
  hero: HeroView;
  actions: HeroAction[];
  /** The action currently running ("retry", "refresh"), for its busy state. */
  busy: HeroAction["id"] | null;
  onAction: (id: "retry" | "refresh") => void;
  error: string | null;
  /** Dev-only "simulate the bank" controls for a pending mock payment. */
  bank: { busy: boolean; onAnswer: (ok: boolean) => void } | null;
  /** Shown above the actions (the terms checkbox of an order our team prepared). */
  beforeActions?: React.ReactNode;
};

const HERO_BUTTON = "rounded-12 px-[18px] py-3 text-base leading-[normal]";

/**
 * Status hero (Order.dc.html): tone by state, icon tile (spinner while confirming), "ORDER {id}" overline, title and
 * body in a polite live region so state changes are announced, the confirming checklist, and the state's actions.
 */
export function OrderHero({ orderId, hero, actions, busy, onAction, error, bank, beforeActions }: OrderHeroProps) {
  const tone = HERO_TONE_CLASSES[hero.tone];
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-5 rounded-[26px] border p-[clamp(24px,4vw,40px)] print:border-line print:bg-surface",
        tone.card,
      )}
    >
      <span aria-hidden="true" className={cn("grid size-[60px] flex-none place-items-center rounded-18 bg-surface", tone.fg)}>
        {hero.spinning ? (
          <span className={cn("block size-7 rounded-pill border-[3px] border-solid animate-spin-fast motion-reduce:animate-none", tone.spinner)} />
        ) : (
          <Icon name={hero.icon} size={32} />
        )}
      </span>
      <div className="min-w-0 flex-[1_1_300px]">
        <div role="status" aria-live="polite" aria-atomic="true">
          <div className={cn("text-[13px] font-extrabold tracking-[0.08em]", tone.fg)}>ORDER {orderId}</div>
          <h1 className="mt-1.5 text-[clamp(26px,3.4vw,36px)] font-extrabold tracking-[-0.03em]">{hero.title}</h1>
          <p className="mt-2.5 max-w-[620px] text-base leading-[1.6] text-ink-soft">{hero.body}</p>
        </div>
        {hero.checklist ? <ConfirmingChecklist /> : null}
        {beforeActions ? <div className="mt-5 print:hidden">{beforeActions}</div> : null}
        {actions.length > 0 ? (
          <div className="mt-5 flex flex-wrap gap-2.5 print:hidden">
            {actions.map((action) =>
              "href" in action ? (
                <Button key={action.id} asChild variant={action.primary ? "primary" : "secondary"} className={HERO_BUTTON}>
                  {action.id === "invoice" ? (
                    <a href={action.href} download>
                      {action.label}
                    </a>
                  ) : (
                    <Link href={action.href}>{action.label}</Link>
                  )}
                </Button>
              ) : (
                <Button
                  key={action.id}
                  type="button"
                  variant={action.primary ? "primary" : "secondary"}
                  className={HERO_BUTTON}
                  loading={busy === action.id}
                  onClick={() => onAction(action.id)}
                >
                  {action.label}
                </Button>
              ),
            )}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 max-w-[620px] text-[14.5px] font-semibold text-pink-fg">
            {error}
          </p>
        ) : null}
        {bank ? <BankControls {...bank} /> : null}
      </div>
    </div>
  );
}

function ConfirmingChecklist() {
  return (
    <ol className="mt-5 grid list-none gap-2.5 p-0 text-[15px] font-bold">
      <li className="flex items-center gap-2.5">
        <Icon name="check_circle" size={20} className="text-sage-fg" />
        Payment submitted to the gateway
      </li>
      <li className="flex items-center gap-2.5">
        <Icon name="pending" size={20} className="text-blue-fg" />
        Waiting for our server to verify it with the provider
      </li>
      <li className="flex items-center gap-2.5 text-ink-2">
        <Icon name="radio_button_unchecked" size={20} />
        Issue your license
      </li>
    </ol>
  );
}

const BANK_LINK =
  "cursor-pointer border-0 bg-transparent p-0 font-extrabold underline underline-offset-2 aria-disabled:cursor-progress aria-disabled:opacity-60";

/** The prototype's "simulate the bank" box, for a pending mock payment in development only. */
function BankControls({ busy, onAnswer }: { busy: boolean; onAnswer: (ok: boolean) => void }) {
  const run = (ok: boolean) => () => {
    if (!busy) onAnswer(ok);
  };
  return (
    <div className="mt-4 rounded-14 border border-dashed border-peach-fg/35 bg-surface/60 p-3.5 text-[13.5px] print:hidden">
      <strong>Test mode</strong> — simulate the bank’s final answer:{" "}
      <button type="button" aria-disabled={busy || undefined} onClick={run(true)} className={cn(BANK_LINK, "ml-1.5 text-sage-fg")}>
        confirm payment
      </button>
      {" · "}
      <button type="button" aria-disabled={busy || undefined} onClick={run(false)} className={cn(BANK_LINK, "text-pink-fg")}>
        decline payment
      </button>
    </div>
  );
}
