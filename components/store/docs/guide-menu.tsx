"use client";

import { usePathname } from "next/navigation";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { GuideLinks, type GuideLinkGroup } from "@/components/store/docs/guide-links";

export type GuideMenuProps = {
  groups: readonly GuideLinkGroup[];
  currentSlug: string;
  /** "{group} · {title}" of the current guide, shown on the button. */
  currentLabel: string;
};

/**
 * Narrow-screen guide picker (below 900px). The prototype's navigate-on-change select is replaced by a disclosure: a
 * select-styled button (aria-expanded/aria-controls) that reveals the grouped guide links inline. Escape closes it
 * and returns focus to the button; following a link closes it.
 */
export function GuideMenu({ groups, currentSlug, currentLabel }: GuideMenuProps) {
  const pathname = usePathname();
  // Open state belongs to the page it was opened on, so navigating closes the menu without an effect.
  const [openAt, setOpenAt] = React.useState<string | null>(null);
  const open = openAt === pathname;
  const rootRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const id = React.useId();
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const panelId = `${id}-panel`;

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focusInside = rootRef.current?.contains(document.activeElement) ?? false;
      setOpenAt(null);
      if (focusInside) buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div ref={rootRef}>
      <span id={labelId} className="block text-[13px] font-extrabold uppercase leading-[normal] text-ink-2">
        Guide
      </span>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => setOpenAt(open ? null : pathname)}
        className="mt-1.5 flex h-[46px] w-full cursor-pointer items-center justify-between gap-2 rounded-12 border border-line-input bg-surface pl-2.5 pr-2 text-left text-[13px] font-bold text-ink transition-colors hover:border-primary"
      >
        <span id={valueId} className="min-w-0 truncate">
          {currentLabel}
        </span>
        <Icon name={open ? "expand_less" : "expand_more"} size={20} className="text-ink-2" />
      </button>
      <div id={panelId} hidden={!open} className="mt-2 rounded-14 border border-line bg-surface p-2">
        <GuideLinks
          groups={groups}
          currentSlug={currentSlug}
          idPrefix={`${id}-menu`}
          onNavigate={() => setOpenAt(null)}
        />
      </div>
    </div>
  );
}
