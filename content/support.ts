/**
 * Copy for /support (Support.dc.html). The FAQ list itself is data: Faq(page = "support"), with an optional guide link
 * (Faq.href), read through getFaqs("support"). Contact details, hours and SLAs that depend on settings are filled in
 * by the page from settings.business.
 */
import type { IconName } from "@/components/icons/icon";
import type { Tone } from "@/lib/design/tokens";

export const SUPPORT_META = {
  title: "Support center",
  description: "Get help with installation, licenses, renewals and billing for Axiomatic software.",
  path: "/support",
} as const;

/** Portal routes (docs/decisions.md: the portal lives under /account). */
export const RAISE_TICKET_HREF = "/account/tickets/new";

export const SUPPORT_HERO = {
  title: "How can we help?",
  searchLabel: "Search help articles",
  searchPlaceholder: "Describe your problem, e.g. activation limit",
  searchButton: "Search",
  popularLabel: "Popular topics",
  popular: [
    { label: "Activation limit", href: "/docs/activate" },
    { label: "Move to new PC", href: "/docs/move" },
    { label: "Backups", href: "/docs/backup" },
    { label: "Printer setup", href: "/docs/printers" },
  ],
} as const;

export type SupportTask = { icon: IconName; tone: Tone; title: string; description: string; href: string };

export const SUPPORT_TASKS: { readonly title: string; readonly items: readonly SupportTask[] } = {
  title: "Do it yourself",
  items: [
    {
      icon: "download",
      tone: "blue",
      title: "Download software",
      description: "Get the installer for the version your license allows.",
      href: "/account/software",
    },
    {
      icon: "key",
      tone: "lavender",
      title: "Find my license key",
      description: "Reveal and copy your key from your account.",
      href: "/account/licenses",
    },
    {
      icon: "swap_horiz",
      tone: "sage",
      title: "Move to a new computer",
      description: "Deactivate the old PC and activate the new one.",
      href: "/docs/move",
    },
    {
      icon: "autorenew",
      tone: "peach",
      title: "Renew or upgrade",
      description: "Extend a license or add computers.",
      href: "/account/licenses",
    },
    {
      icon: "receipt_long",
      tone: "pink",
      title: "Download an invoice",
      description: "GST invoices for every order.",
      href: "/account/orders",
    },
    {
      icon: "menu_book",
      tone: "blue",
      title: "Installation guides",
      description: "Step-by-step setup for Windows and macOS.",
      href: "/docs/install",
    },
  ],
};

export const SUPPORT_CHANNELS = {
  title: "Contact support",
  /** "{hours} (configurable). Have your license ID ready." ("(configurable)" only while the details are samples). */
  intro: (hours: string, sample: boolean) => `${hours}${sample ? " (configurable)" : ""}. Have your license ID ready.`,
  ticket: {
    title: "Support ticket",
    body: "Best for most issues. Attach screenshots and track replies in your account.",
    sla: "First reply within 1 business day",
    cta: "Raise a ticket",
  },
  email: {
    title: "Email",
    /** Follows the support address. */
    bodyAfterAddress: " — include your order or license ID.",
    sla: "Replies within 1 business day",
  },
  phone: {
    title: "Phone",
    /** Follows the phone number ("(placeholder)" only while the details are samples). */
    bodyAfterNumber: (sample: boolean) => `${sample ? " (placeholder)" : ""}. Priority line for maintenance plan customers.`,
    sla: "During support hours",
  },
} as const;

export const SUPPORT_FAQ_COPY = {
  title: "Common questions",
  /** "3 answers for “backup”" (live search result heading and announcement). */
  resultsTitle: (count: number, query: string) => `${count} answer${count === 1 ? "" : "s"} for “${query}”`,
  readGuide: "Read the guide",
  emptyBefore: "No matching answers. ",
  emptyLink: "Raise a ticket",
  emptyAfter: " and we’ll help.",
} as const;

/** Live filtering starts after this many characters; the Search button applies any query. */
export const SUPPORT_LIVE_SEARCH_MIN = 3;
