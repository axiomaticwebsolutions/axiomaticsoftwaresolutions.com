import { Icon } from "@/components/icons/icon";

/**
 * Temporary body of a module page until its builder replaces app/admin/<module>/page.tsx (Phase 6 foundation).
 * Server-safe.
 */
export function ModulePlaceholder({ label }: { label: string }) {
  return (
    <div className="rounded-14 border border-dashed border-line-input bg-surface px-6 py-12 text-center">
      <span aria-hidden="true" className="mx-auto grid size-12 place-items-center rounded-14 bg-lavender-bg text-lavender-fg">
        <Icon name="pending" size={24} />
      </span>
      <h2 className="mb-0 mt-3 text-[16px] font-extrabold">{label} is on its way</h2>
      <p className="mx-auto mb-0 mt-1.5 max-w-[440px] text-[13.5px] leading-[1.6] text-ink-2">
        This module is still being built. The rest of the console works as usual.
      </p>
    </div>
  );
}
