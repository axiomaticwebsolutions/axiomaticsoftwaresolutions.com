/**
 * Product page copy (design_handoff_axiomatic/prototype/Product.dc.html), kept in one typed module so it is easy to
 * edit. Product-specific text (features, plans, requirements, releases, FAQs) comes from the catalog; this file holds
 * the page's own headings, notes and policy copy. Deliberate changes from the prototype (docs/decisions.md > Phase 2):
 * install step 1 names the portal page "Software & downloads"; the annual & subscription card says renewals are
 * manual (decision 2). Pure and client-safe.
 */

/** In-page navigation, in page order (prototype `sections`). "Related" is not in the nav. */
export const PRODUCT_SECTIONS = [
  { id: "features", label: "Features" },
  { id: "plans", label: "Plans" },
  { id: "requirements", label: "Requirements" },
  { id: "install", label: "Installation" },
  { id: "releases", label: "Releases" },
  { id: "support", label: "Support" },
  { id: "faqs", label: "FAQs" },
] as const;

export type ProductSectionId = (typeof PRODUCT_SECTIONS)[number]["id"];

export const PRODUCT_COPY = {
  breadcrumbHome: "Home",
  breadcrumbSoftware: "Software",
  from: "From",
  choosePlan: "Choose a plan",
  startTrial: "Start free trial",
  requestDemo: "Request a demo",
  versionChip: (version: string) => `Version ${version}`,
  screenshotsLabel: "Screenshots",
  screenshotAria: (shortName: string, title: string) => `Placeholder screenshot of ${shortName}: ${title}`,
  inPageNavLabel: "On this page",

  featuresTitle: "Features",
  benefitsTitle: "What it does for your business",

  plansTitle: "Plans and license limits",
  plansNoteExcl: (ratePct: number) =>
    `Prices exclude GST. ${ratePct}% GST is added at checkout based on your billing state.`,
  plansNoteIncl: (ratePct: number) =>
    `Prices include ${ratePct}% GST. Final tax is calculated from your billing state at checkout.`,
  mostChosen: "Most chosen",
  free: "Free",
  noPaymentNeeded: "No payment needed",
  taxLineExcl: (ratePct: number) => `+ ${ratePct}% GST at checkout`,
  taxLineIncl: (ratePct: number) => `Includes ${ratePct}% GST`,
  addToCart: "Add to cart",

  addOnsTitle: "Add-ons for existing licenses",
  addFromAccount: "Add from your account",

  requirementsTitle: "System requirements",

  installTitle: "Installation and activation",
  installGuide: "Read the full installation guide →",

  releasesTitle: "Releases",
  releasesLead: "Customers with an active license or maintenance plan download updates from their account.",
  latest: "Latest",
  earlierVersions: "Earlier versions",

  supportTitle: "Support and update policy",

  faqsTitle: "Frequently asked questions",
  faqGuide: "Read the guide",

  relatedTitle: "Related software",

  toastAdded: "Added to cart",
  toastAlreadyInCart: "Already in your cart",
  toastViewCart: "View cart",
  toastKeepBrowsing: "Keep browsing",
  cartFull: "Your cart is full. Remove an item to add another.",
  cartInvalid: "This plan can’t be added to the cart right now.",

  notFoundTitle: "We couldn’t find that product",
  notFoundBody: "It may have been renamed or is no longer sold.",
  notFoundCta: "Browse all software",

  relatedComingSoon: "Coming soon",
} as const;

/**
 * Copy of a COMING_SOON product page (decisions.md 2026-10-09): what the product will do, no prices, and the
 * "Notify me when it launches" form. The purpose notice follows the contact form's (DPDP: say what the details are for).
 */
export const COMING_SOON_COPY = {
  badge: "Coming soon",
  metaTitle: (name: string) => `${name} (coming soon)`,
  metaDescription: (tagline: string) => `Coming soon: ${tagline} Join the waitlist to hear when it launches.`,
  heroNote: "This software is not on sale yet. Leave your email and we’ll tell you when it launches.",
  notifyCta: "Notify me when it launches",
  browseAvailable: "See software available now",
  featuresTitle: "Planned features",
  benefitsTitle: "What it will do for your business",
  requirementsTitle: "Planned system requirements",

  formTitle: "Notify me when it launches",
  formLede: (shortName: string) => `We’ll send one email when ${shortName} is ready to buy. No spam.`,
  name: "Your name",
  email: "Email",
  phone: "Phone",
  businessName: "Business name",
  optional: "Optional",
  submit: "Notify me",
  sending: "Sending…",
  noticeBeforeLink: (shortName: string) => `We’ll use these details only to tell you when ${shortName} launches. See our `,
  noticeLink: "privacy policy",
  noticeAfterLink: ".",
  privacyHref: "/legal/privacy",
  honeypotLabel: "Leave this field empty",
  sentTitle: "You’re on the list",
  sentBody: (name: string) => `Thanks — we’ll email you when ${name} launches.`,
} as const;

/** Full installation guide (Docs article "install"). */
export const INSTALL_GUIDE_HREF = "/docs/install";

/** Portal page where existing licenses get device add-ons and maintenance (docs/decisions.md > Phase 2). */
export const ACCOUNT_LICENSES_HREF = "/account/licenses";

export type InstallStep = { title: string; body: string };

/** "10 minutes" / "1 minute". */
export function minutesLabel(minutes: number): string {
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** The four install steps; `downloadLinkMinutes` comes from settings.licensing (10 by default). */
export function installSteps(downloadLinkMinutes: number): InstallStep[] {
  return [
    {
      title: "Download the installer",
      body: `Sign in to your account and open Software & downloads. Download links are valid for ${minutesLabel(downloadLinkMinutes)}.`,
    },
    {
      title: "Run the setup",
      body: "Open the downloaded file and follow the steps. Setup takes about two minutes.",
    },
    {
      title: "Enter your license key",
      body: "Copy the key from your account or order email and paste it when the software asks.",
    },
    {
      title: "Start billing",
      body: "Add your business details, import items if you have them, and print your first bill.",
    },
  ];
}

export type PolicyCard = { title: string; body: string; tone: "blue" | "peach" | "sage" };

/**
 * The three "Support and update policy" cards. Hours come from settings.business.hours; "Hours are configurable."
 * is the prototype's sample note, shown only while the business details are sample placeholders.
 */
export function policyCards(business: { hours: string; sample: boolean }): PolicyCard[] {
  const hours = business.hours.trim();
  const reach = hours ? `${hours} by ticket, email and phone.` : "By ticket, email and phone.";
  return [
    {
      title: "Annual & subscription",
      body: "All updates and standard support are included while the license is active. Renewal is manual, from your account.",
      tone: "blue",
    },
    {
      title: "One-time licenses",
      body: "12 months of updates and support are included. The software keeps working afterwards; renew maintenance for newer versions.",
      tone: "peach",
    },
    {
      title: "Support hours",
      body: business.sample ? `${reach} Hours are configurable.` : reach,
      tone: "sage",
    },
  ];
}
