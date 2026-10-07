/**
 * Legal documents (Legal.dc.html): terms, privacy, refund policy and EULA, as code content versioned with the app
 * (docs/decisions.md > Phase 2). SAMPLE text: every document is marked "Sample — to be reviewed by counsel" until a
 * lawyer has reviewed it; then set `status: "reviewed"`, raise `version` and update `lastUpdated`.
 *
 * `{token}` placeholders: seller name and email addresses come from Admin > Settings (business), the offline grace
 * period from env LICENSE_OFFLINE_GRACE_DAYS. Values still in [brackets] are policy decisions for counsel
 * (LEGAL_PLACEHOLDERS). Section ids are URL fragments (/legal/terms#liability): keep them stable. Pure and
 * client-safe (type-only imports).
 */
import type { BusinessSettings } from "@/lib/config";
import { SITE_NAME } from "@/lib/seo/metadata";
import { plural } from "@/content/docs/template";

export const LEGAL_DOC_SLUGS = ["terms", "privacy", "refund", "eula"] as const;
export type LegalDocSlug = (typeof LEGAL_DOC_SLUGS)[number];

/** /legal redirects here. */
export const DEFAULT_LEGAL_DOC: LegalDocSlug = "terms";

export type LegalSection = {
  /** Fragment id, e.g. "liability". */
  id: string;
  heading: string;
  paragraphs: readonly string[];
};

export type LegalDocument = {
  slug: LegalDocSlug;
  /** Label in the document switcher. */
  tabLabel: string;
  title: string;
  /** Page description (search results and link previews). */
  description: string;
  intro: string;
  /** Shown as "Version 0.1". */
  version: string;
  /** IST calendar date of the last change, YYYY-MM-DD. */
  lastUpdated: string;
  /** "sample" shows the counsel-review notice and "(draft)" after the version. */
  status: "sample" | "reviewed";
  sections: readonly LegalSection[];
};

/** Bracketed values counsel still has to confirm. Replace the whole string, brackets included. */
export const LEGAL_PLACEHOLDERS = Object.freeze({
  refundWindowDays: "[7]",
  retentionPeriod: "[e.g. 8 years]",
  jurisdictionCity: "[city]",
});

export const LEGAL_TOKENS = [
  "sellerName",
  "legalEmail",
  "privacyEmail",
  "supportEmail",
  "offlineGrace",
  "refundWindowDays",
  "retentionPeriod",
  "jurisdictionCity",
] as const;
export type LegalToken = (typeof LEGAL_TOKENS)[number];
export type LegalValues = Readonly<Record<LegalToken, string>>;

/** Tokens rendered as mailto: links. */
export const LEGAL_EMAIL_TOKENS: ReadonlySet<string> = new Set<LegalToken>(["legalEmail", "privacyEmail", "supportEmail"]);

/** Token in LEGAL_FOOTER rendered as a link to the contact page. */
export const CONTACT_LINK_TOKEN = "contactUs";

export const LEGAL_COPY = {
  breadcrumb: "Legal",
  sampleTitle: "Sample — to be reviewed by counsel.",
  sampleBody: "Have a qualified lawyer review and adapt every policy before publishing. Values in brackets are configurable.",
  onThisPage: "On this page",
  print: "Print",
  footer: "Questions about this document? Write to {legalEmail} or {contactUs}.",
  contactUs: "contact us",
} as const;

export type LegalValuesInput = {
  business: Pick<BusinessSettings, "legalName" | "legalEmail" | "privacyEmail" | "supportEmail" | "sample">;
  /** env LICENSE_OFFLINE_GRACE_DAYS */
  offlineGraceDays: number;
};

/**
 * Token values. While the seller details are placeholders (business.sample) the documents name the brand, as the
 * footer does; once real details are saved they name the registered legal entity.
 */
export function legalValues({ business, offlineGraceDays }: LegalValuesInput): LegalValues {
  return {
    sellerName: business.sample ? SITE_NAME : business.legalName,
    legalEmail: business.legalEmail,
    privacyEmail: business.privacyEmail,
    supportEmail: business.supportEmail,
    offlineGrace: plural(offlineGraceDays, "day"),
    ...LEGAL_PLACEHOLDERS,
  };
}

export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocSlug, LegalDocument>> = {
  terms: {
    slug: "terms",
    tabLabel: "Terms",
    title: "Terms of service",
    description: "The terms for browsing our website, creating an account and buying Axiomatic software.",
    intro:
      "These terms apply when you browse our website, create an account or buy software from {sellerName} (“we”, “us”). By using the website you agree to them.",
    version: "0.1",
    lastUpdated: "2026-10-07",
    status: "sample",
    sections: [
      {
        id: "your-account",
        heading: "Your account",
        paragraphs: [
          "You must give accurate contact and billing details and keep your password private. You’re responsible for activity under your account, including team members you invite.",
          "You can buy as a guest. Purchases are linked to the email you use and appear when you create or sign in to an account with that email.",
        ],
      },
      {
        id: "orders-and-payment",
        heading: "Orders and payment",
        paragraphs: [
          "Prices are shown in Indian rupees. We show whether a price includes GST. Tax is calculated at checkout from your billing state.",
          "An order is confirmed only after our payment provider confirms the payment to our server. If a payment is pending, we issue the license automatically once it’s confirmed.",
        ],
      },
      {
        id: "licenses",
        heading: "Licenses",
        paragraphs: [
          "Software is licensed, not sold. Your rights are set out in the End User License Agreement and the plan you choose.",
        ],
      },
      {
        id: "acceptable-use",
        heading: "Acceptable use",
        paragraphs: [
          "Don’t attempt to bypass license checks, share keys publicly, resell licenses without our written permission or interfere with our systems.",
        ],
      },
      {
        id: "changes-and-availability",
        heading: "Changes and availability",
        paragraphs: [
          "We may update the website, prices and these terms. Changes don’t affect orders already placed. We’ll give notice of material changes by email.",
        ],
      },
      {
        id: "liability",
        heading: "Liability",
        paragraphs: [
          "To the extent permitted by law, our total liability for any claim is limited to the amount you paid for the product in the 12 months before the claim. [Review with counsel.]",
        ],
      },
      {
        id: "governing-law",
        heading: "Governing law",
        paragraphs: ["These terms are governed by the laws of India. Courts at {jurisdictionCity} have jurisdiction."],
      },
    ],
  },
  privacy: {
    slug: "privacy",
    tabLabel: "Privacy",
    title: "Privacy policy",
    description: "What personal data we collect, why, and the choices you have.",
    intro: "This policy explains what personal data we collect, why, and the choices you have.",
    version: "0.1",
    lastUpdated: "2026-10-07",
    status: "sample",
    sections: [
      {
        id: "what-we-collect",
        heading: "What we collect",
        paragraphs: [
          "Account details (name, email, phone), business and billing details including optional GSTIN, order and payment records, support conversations, and device details needed to activate licenses.",
          "We do not receive card numbers or UPI PINs. Payments are processed by our payment provider.",
        ],
      },
      {
        id: "license-activation-data",
        heading: "License activation data",
        paragraphs: [
          "When the software activates or checks a license, it sends the license key, a hashed device identifier, device name, operating system and app version. Your billing data stays on your computer.",
        ],
      },
      {
        id: "how-we-use-data",
        heading: "How we use data",
        paragraphs: [
          "To deliver and support software, issue invoices, prevent misuse of licenses, send service emails such as renewal reminders, and improve our products. Marketing emails are sent only if you opt in.",
        ],
      },
      {
        id: "sharing",
        heading: "Sharing",
        paragraphs: [
          "With service providers who help us run the business (payment, email, hosting, storage) under contract, and when required by law. We don’t sell personal data.",
        ],
      },
      {
        id: "retention-and-security",
        heading: "Retention and security",
        paragraphs: [
          "We keep order and invoice records as required by tax law {retentionPeriod}. Passwords are stored as one-way hashes. Access to customer data is limited by staff role and recorded in audit logs.",
        ],
      },
      {
        id: "your-choices",
        heading: "Your choices",
        paragraphs: [
          "You can update your details, change email preferences, export your account data or ask us to delete your account, subject to records we must keep by law. Contact {privacyEmail}.",
        ],
      },
    ],
  },
  refund: {
    slug: "refund",
    tabLabel: "Refunds",
    title: "Refund policy",
    description: "When you can ask for a refund on Axiomatic software, how to request one and what happens next.",
    intro: "We want you to buy with confidence. Where a free trial is available, please try the software first.",
    version: "0.1",
    lastUpdated: "2026-10-07",
    status: "sample",
    sections: [
      {
        id: "eligibility",
        heading: "Eligibility",
        paragraphs: [
          // Reworded (docs/decisions.md 2): subscriptions are prepaid periods renewed manually, so nothing is cancelled.
          "You can request a refund within {refundWindowDays} days of purchase for one-time and annual licenses. Subscriptions renew only when you renew them and remain active until the end of the paid period; past periods aren’t refunded.",
          "Maintenance plans and additional computers are refundable within {refundWindowDays} days if not yet used.",
        ],
      },
      {
        id: "how-to-request",
        heading: "How to request",
        paragraphs: [
          "Raise a support ticket from your account or email {supportEmail} with your order ID and the reason.",
        ],
      },
      {
        id: "what-happens-next",
        heading: "What happens next",
        paragraphs: [
          "Approved refunds go back to the original payment method through our payment provider, usually within 5–7 working days. A credit note is issued for GST purposes.",
          "Licenses from a refunded order are revoked and stop working on all devices.",
        ],
      },
      {
        id: "exceptions",
        heading: "Exceptions",
        paragraphs: [
          "We may decline refunds where a license has been extensively used, after the refund window, or in cases of misuse.",
        ],
      },
    ],
  },
  eula: {
    slug: "eula",
    tabLabel: "License agreement",
    title: "End User License Agreement",
    description: "The license agreement for all Axiomatic software you install: license types, activation and restrictions.",
    intro:
      "This agreement is between you (the licensee) and {sellerName}. It applies to all Axiomatic software you install.",
    version: "0.1",
    lastUpdated: "2026-10-07",
    status: "sample",
    sections: [
      {
        id: "grant-of-license",
        heading: "Grant of license",
        paragraphs: [
          "We grant you a non-exclusive, non-transferable license to install and use the software for your own business, on up to the number of devices stated in your plan.",
        ],
      },
      {
        id: "license-types",
        heading: "License types",
        paragraphs: [
          "Trial: for evaluation for the stated number of days. One-time: perpetual use of versions released during your update period. Annual and subscription: use while the term is active. Device and maintenance add-ons attach to an existing license.",
        ],
      },
      {
        id: "activation",
        heading: "Activation",
        paragraphs: [
          "The software must be activated with a valid key and checks the license periodically. If it can’t connect, it continues working for a grace period of {offlineGrace}.",
        ],
      },
      {
        id: "restrictions",
        heading: "Restrictions",
        paragraphs: [
          "You may not copy, modify, reverse engineer, rent or resell the software, remove notices, or circumvent license checks, except as allowed by law.",
        ],
      },
      {
        id: "your-data",
        heading: "Your data",
        paragraphs: ["Data you create stays on your devices and belongs to you. You’re responsible for backups."],
      },
      {
        id: "updates-and-support",
        heading: "Updates and support",
        paragraphs: ["Updates and support are provided as described in your plan and our support policy."],
      },
      {
        id: "termination",
        heading: "Termination",
        paragraphs: [
          "This license ends if you breach it or if the license is revoked after a refund. When it ends, you must stop using the software.",
        ],
      },
      {
        id: "warranty",
        heading: "Warranty",
        paragraphs: ["The software is provided “as is” to the extent permitted by law. [Review with counsel.]"],
      },
    ],
  },
};

export function isLegalDocSlug(value: string): value is LegalDocSlug {
  return (LEGAL_DOC_SLUGS as readonly string[]).includes(value);
}

export function legalDocHref(slug: LegalDocSlug): string {
  return `/legal/${slug}`;
}

/** Documents in switcher order. */
export function legalDocuments(): LegalDocument[] {
  return LEGAL_DOC_SLUGS.map((slug) => LEGAL_DOCUMENTS[slug]);
}
