/**
 * About us page copy (/about), verbatim from design_handoff_axiomatic/prototype/About.dc.html.
 * Company details (registered name, GSTIN, office, hours) are NOT here: they come from settings.business and are
 * marked sample/placeholder while `business.sample` is true.
 */
import type { IconName } from "@/components/icons/registry";
import type { Tone } from "@/lib/design/tokens";

export const ABOUT_PAGE = {
  path: "/about",
  /** Document title; the root template adds " — Axiomatic Software Solutions". */
  title: "About us",
  description: "Axiomatic Software Solutions builds licensed billing and business software for Indian small businesses.",
  breadcrumbHome: "Home",
  breadcrumb: "About us",
} as const;

export const ABOUT_HERO = {
  overline: "About Axiomatic",
  heading: "Software that does its job, every working day.",
  lead: "Axiomatic Software Solutions builds billing and business software for chemists, restaurants, retail shops and offices across India. We sell it under clear licenses and support it with regular updates.",
  /** Remove (set to null) once the story above is the company's own. */
  storyNote: "Company story is placeholder copy — replace with your own." as string | null,
  /** Label on the illustration until a real team or office photo replaces it (null hides it). */
  photoNote: "Placeholder · team or office photo" as string | null,
} as const;

export type Principle = { icon: IconName; tone: Tone; title: string; body: string };

export const ABOUT_PRINCIPLES: { heading: string; items: readonly Principle[] } = {
  heading: "How we work",
  items: [
    {
      icon: "target",
      tone: "lavender",
      title: "Focused products",
      body: "Each product is built for one kind of business, so the screens match how that business works.",
    },
    {
      icon: "handshake",
      tone: "sage",
      title: "Straight licensing",
      body: "You can see what you bought, how long it lasts and which computers use it.",
    },
    {
      icon: "update",
      tone: "blue",
      title: "Steady improvement",
      body: "We release updates regularly and publish release notes for every version.",
    },
    {
      icon: "lock",
      tone: "peach",
      title: "Your data, your computer",
      body: "Billing data stays on your computers. We only receive what’s needed to check your license.",
    },
  ],
};

export const ABOUT_PRODUCTS = { heading: "What we build" } as const;

export const ABOUT_COMPANY = {
  heading: "Company details",
  terms: { legalName: "Registered name", gstin: "GSTIN", office: "Office", hours: "Support hours" },
  /** Appended to seller details while settings.business.sample is true. */
  sampleMark: "(sample)",
  placeholderMark: "(placeholder)",
} as const;

export const ABOUT_CONTACT = {
  heading: "Talk to us",
  body: "Questions about a product, a license or a partnership? We’ll get back within one business day.",
  contact: "Contact us",
  demo: "Request a demo",
} as const;
