"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { useAdmin } from "@/components/admin/admin-context";
import { searchModules, type AdminModuleView } from "@/components/admin/admin-nav";
import { useCommandShortcut } from "@/components/ui/command";
import { adminGroupTitle } from "@/lib/rbac";
import { cn } from "@/lib/utils";

function isModifiedClick(event: React.MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/** Whether a key press happens while the user is typing (then "/" is just a character). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** A drawer, dialog or menu is open: its focus trap owns the keyboard, so the shortcuts stay out of the way. */
function modalOpen(): boolean {
  return document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open'], [role='menu'][data-state='open']") !== null;
}

/** Focuses the field on "/" from anywhere outside a text field (Ctrl/Cmd+K is useCommandShortcut). */
function useSlashShortcut(onFocus: () => void): void {
  const latest = React.useRef(onFocus);
  React.useEffect(() => {
    latest.current = onFocus;
  });
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isTyping(event.target) || modalOpen()) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

/**
 * Top-bar module search (Admin Console.dc.html top bar): an ARIA combobox that filters the admin modules by name,
 * title, group and description and opens the chosen one. Ctrl/Cmd+K or "/" focuses it from anywhere; Up/Down move,
 * Enter opens, Escape closes (a second Escape clears). Locked modules stay listed with a lock: they open the
 * permission-denied page, like the sidebar. On phones the results use the width of the screen under the bar.
 */
export function ModuleSearch({ className }: { className?: string }) {
  const router = useRouter();
  const { modules } = useAdmin();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const uid = React.useId();
  const inputId = `${uid}-input`;
  const listId = `${uid}-list`;
  const optionId = (index: number) => `${uid}-opt-${index}`;

  const results = React.useMemo(() => searchModules(modules, query), [modules, query]);
  const activeIndex = results.length > 0 ? Math.min(active, results.length - 1) : -1;

  const focusField = React.useCallback(() => {
    if (modalOpen()) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    setOpen(true);
  }, []);
  useCommandShortcut(focusField);
  useSlashShortcut(focusField);

  // aria-activedescendant moves the highlight but not the popup's scroll: keep the highlighted option in view.
  React.useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${uid}-opt-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, uid]);

  const go = (item: AdminModuleView) => {
    setOpen(false);
    setQuery("");
    setActive(0);
    inputRef.current?.blur();
    router.push(item.href);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = results.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) setOpen(true);
        else if (count > 0) setActive((i) => (Math.min(i, count - 1) + 1) % count);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) setOpen(true);
        else if (count > 0) setActive((i) => (Math.min(i, count - 1) - 1 + count) % count);
        break;
      case "Home":
      case "End":
        if (open && count > 0 && !event.shiftKey) {
          event.preventDefault();
          setActive(event.key === "Home" ? 0 : count - 1);
        }
        break;
      case "Enter": {
        const target = open && activeIndex >= 0 ? results[activeIndex] : undefined;
        if (target) {
          event.preventDefault();
          go(target);
        }
        break;
      }
      case "Escape":
        // Also stops the browser clearing a search field on Escape: the first Escape only closes the list.
        event.preventDefault();
        event.stopPropagation();
        if (open) setOpen(false);
        else if (query) setQuery("");
        else inputRef.current?.blur();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const term = query.trim();
  const status = !open
    ? ""
    : results.length === 0
      ? `No modules match \u201c${term}\u201d.`
      : `${results.length} ${results.length === 1 ? "module" : "modules"}`;
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div className={cn("relative min-w-0 max-w-[460px] flex-1", className)}>
      <label
        htmlFor={inputId}
        className="flex h-9 cursor-text items-center gap-2 rounded-9 border border-line-alt bg-bg px-2.5 transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-focus"
      >
        <Icon name="search" size={18} className="text-ink-3" />
        <span className="sr-only">Search admin modules</span>
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-keyshortcuts="Control+K Meta+K /"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder="Search modules"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13.5px] font-semibold text-ink outline-none placeholder:text-ink-3 focus-visible:outline-hidden"
        />
        <kbd
          aria-hidden="true"
          className="hidden rounded-6 border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[11px] leading-[normal] text-ink-2 min-[45rem]:inline"
        >
          Ctrl K
        </kbd>
      </label>
      <div
        hidden={!open}
        className={cn(
          // The listbox itself scrolls (not this wrapper): it is the combobox popup, which arrow keys scroll through
          // aria-activedescendant, so it needs no Tab stop (axe scrollable-region-focusable exempts combobox popups).
          "absolute inset-x-0 top-[42px] z-40 flex max-h-[min(440px,calc(100dvh-80px))] flex-col rounded-12 border border-line-alt bg-surface p-1.5 shadow-menu",
          // Phones: the field is narrow, so the list uses the width of the screen under the bar.
          "max-[45rem]:fixed max-[45rem]:inset-x-3 max-[45rem]:top-[60px] max-[45rem]:max-h-[calc(100dvh-76px)]",
        )}
      >
        {results.length === 0 ? <p className="m-0 shrink-0 p-3 text-[13.5px] text-ink-2">{status}</p> : null}
        <div
          id={listId}
          role="listbox"
          aria-label="Admin modules"
          tabIndex={-1}
          onMouseDown={keepFocus}
          className="min-h-0 overflow-y-auto"
        >
          {results.map((item, i) => {
            const selected = i === activeIndex;
            return (
              <a
                key={item.key}
                id={optionId(i)}
                role="option"
                aria-selected={selected}
                href={item.href}
                tabIndex={-1}
                onMouseMove={() => setActive(i)}
                onClick={(event) => {
                  if (isModifiedClick(event)) return;
                  event.preventDefault();
                  go(item);
                }}
                className={cn(
                  "flex items-center gap-2.5 rounded-9 px-2 py-[7px] text-ink no-underline hover:text-ink",
                  selected && "bg-lavender-soft",
                )}
              >
                <span aria-hidden="true" className="grid size-[30px] flex-none place-items-center rounded-9 bg-slate-bg text-ink-2">
                  <Icon name={item.icon} size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-bold">{item.label}</span>
                  <span className="block truncate text-[12px] font-semibold text-ink-2">{adminGroupTitle(item.group)}</span>
                </span>
                {item.locked ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-bold text-ink-2">
                    <Icon name="lock" size={14} />
                    Restricted
                  </span>
                ) : null}
              </a>
            );
          })}
        </div>
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>
    </div>
  );
}
