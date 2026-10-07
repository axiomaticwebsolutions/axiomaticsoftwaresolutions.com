import { Icon } from "@/components/icons/icon";
import { HERO_ILLUSTRATION } from "@/content/home";
import { cn } from "@/lib/utils";

/** Floating card elevation from the prototype (0 20px 50px ink/16% plus a 1px ink/6% outline). */
const FLOAT = "shadow-[0_20px_50px_--alpha(theme(colors.ink)/16%)] ring-1 ring-ink/6";

/**
 * The hero's illustrated UI composite, built in HTML (no screenshot): a billing window, a cheque card and a
 * "License active" chip on a lavender -> blue -> sage panel. Purely decorative, so it is hidden from assistive
 * technology and a visually hidden sentence describes it instead.
 *
 * Sizes are container-query units of the composite, like the prototype, so it scales as one picture. The outer
 * padding uses svw on purpose: in the prototype those cqw values sit on the container itself, which resolves them
 * against the viewport (no ancestor container), and svw keeps exactly that result.
 */
export function HeroIllustration() {
  const { window: win, cheque, license } = HERO_ILLUSTRATION;
  return (
    <div className="min-w-0">
      <p className="sr-only">{HERO_ILLUSTRATION.description}</p>
      <div aria-hidden="true" className="@container relative pt-[5svw] pb-[24svw] pl-[6svw] leading-[normal] select-none">
        <div className="absolute inset-0 rounded-32 bg-linear-140/srgb from-lavender-bg via-blue-bg via-55% to-sage-bg" />

        {/* Billing window */}
        <div
          className={cn(
            "relative -mr-[4cqw] overflow-hidden rounded-[2.6cqw] bg-white text-[length:1.95cqw] text-ink",
            "shadow-[0_30px_70px_--alpha(theme(colors.ink)/16%)] ring-1 ring-ink/6",
          )}
        >
          <div className="flex items-center gap-[1cqw] border-b border-line-subtle bg-bg/50 px-[2.2cqw] py-[1.6cqw]">
            <span className="size-[1.4cqw] rounded-full bg-pink-bg" />
            <span className="size-[1.4cqw] rounded-full bg-peach-bg" />
            <span className="size-[1.4cqw] rounded-full bg-sage-bg" />
            <span className="ml-[1.4cqw] font-bold text-ink-2">{win.title}</span>
            <span className="ml-auto rounded-pill bg-sage-bg px-[1.2cqw] py-[.4cqw] font-bold text-sage-fg">{win.status}</span>
          </div>
          <div className="grid grid-cols-[15cqw_1fr]">
            <div className="grid content-start gap-[1cqw] border-r border-line-subtle bg-bg px-[1.4cqw] py-[2cqw] font-semibold text-ink-2">
              {win.nav.map((item, i) => (
                <span
                  key={item}
                  className={cn("px-[1.2cqw] py-[.9cqw]", i === 0 && "rounded-[1cqw] bg-blue-bg font-bold text-blue-fg")}
                >
                  {item}
                </span>
              ))}
            </div>
            <div className="min-w-0 px-[2.4cqw] py-[2.2cqw]">
              <div className="flex items-baseline justify-between">
                <span className="text-[length:2.7cqw] font-extrabold tracking-[-0.02em]">{win.invoice}</span>
                <span className="font-semibold text-ink-2">{win.invoiceType}</span>
              </div>
              <div className="mt-[1.6cqw] flex items-center gap-[1cqw] rounded-[1.2cqw] border border-line-strong px-[1.6cqw] py-[1.2cqw] text-ink-3">
                <Icon name="barcode_scanner" className="h-[3.12cqw] w-[2.6cqw]" />
                {win.search}
              </div>
              <div className="mt-[1.6cqw] grid grid-cols-[1fr_9cqw_6cqw_11cqw] items-center gap-x-[1cqw] gap-y-[1.25cqw]">
                <span className="font-bold text-ink-3">{win.columns.item}</span>
                <span className="font-bold text-ink-3">{win.columns.hsn}</span>
                <span className="text-right font-bold text-ink-3">{win.columns.qty}</span>
                <span className="text-right font-bold text-ink-3">{win.columns.amount}</span>
                {win.rows.map((row) => (
                  <Row key={row.item} {...row} />
                ))}
              </div>
              <div className="mt-[2cqw] grid grid-cols-[1fr_auto] gap-y-[.8cqw] border-t border-dashed border-line-strong pt-[1.6cqw] font-semibold text-ink-2">
                {win.totals.map((t) => (
                  <Total key={t.label} label={t.label} amount={t.amount} />
                ))}
                <span className="mt-[.6cqw] text-[length:2.6cqw] font-extrabold text-ink">{win.total.label}</span>
                <span className="mt-[.6cqw] text-right text-[length:2.6cqw] font-extrabold text-ink">{win.total.amount}</span>
              </div>
              <div className="mt-[1.8cqw] flex justify-end gap-[1cqw]">
                <span className="rounded-[1cqw] border border-line-strong px-[1.8cqw] py-[1cqw] font-bold">
                  {win.actions.secondary}
                </span>
                <span className="rounded-[1cqw] bg-primary px-[1.8cqw] py-[1cqw] font-bold text-white">{win.actions.primary}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Cheque card */}
        <div
          className={cn(
            "absolute bottom-[2cqw] left-0 w-[52cqw] rounded-[2.2cqw] bg-white px-[2.2cqw] py-[2cqw] text-[length:1.75cqw] text-ink",
            FLOAT,
          )}
        >
          <div className="flex justify-between font-bold text-ink-2">
            <span>{cheque.title}</span>
            <span className="font-mono">{cheque.date}</span>
          </div>
          <div className="mt-[1.4cqw] grid gap-[1cqw] rounded-[1.4cqw] border border-lavender-line bg-lavender-soft p-[1.6cqw]">
            <div className="flex gap-[1cqw]">
              <span className="text-ink-2">{cheque.payLabel}</span>
              <span className="flex-1 border-b border-primary-accent font-bold">{cheque.payee}</span>
            </div>
            <div className="flex items-end gap-[1cqw]">
              <span className="text-ink-2">{cheque.wordsLabel}</span>
              <span className="flex-1 border-b border-primary-accent font-semibold">{cheque.words}</span>
              <span className="rounded-[.8cqw] border-[1.5px] border-primary px-[1.2cqw] py-[.6cqw] font-extrabold">
                {cheque.amount}
              </span>
            </div>
          </div>
        </div>

        {/* License chip */}
        <div
          className={cn(
            "absolute -right-[1cqw] -bottom-[1cqw] flex items-center gap-[1.6cqw] rounded-[2.2cqw] bg-white px-[2.2cqw] py-[1.8cqw]",
            "text-[length:1.8cqw] text-ink",
            FLOAT,
          )}
        >
          <span className="grid size-[5.4cqw] place-items-center rounded-[1.4cqw] bg-sage-bg text-sage-fg">
            <Icon name="key" className="size-[3.2cqw]" />
          </span>
          <span>
            <span className="block font-extrabold">{license.title}</span>
            <span className="mt-[.3cqw] block font-semibold text-ink-2">{license.detail}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function Row({ item, hsn, qty, amount }: { item: string; hsn: string; qty: number; amount: string }) {
  return (
    <>
      <span className="font-semibold">{item}</span>
      <span className="font-mono font-medium text-ink-2">{hsn}</span>
      <span className="text-right">{qty}</span>
      <span className="text-right font-semibold">{amount}</span>
    </>
  );
}

function Total({ label, amount }: { label: string; amount: string }) {
  return (
    <>
      <span>{label}</span>
      <span className="text-right">{amount}</span>
    </>
  );
}
