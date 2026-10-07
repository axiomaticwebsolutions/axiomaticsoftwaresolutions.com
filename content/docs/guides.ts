/**
 * Documentation guides (Docs.dc.html), as code content versioned with the app (docs/decisions.md > Phase 2).
 * Order matters: the sidebar, the prev/next links and /docs (which opens the first guide) follow this list.
 *
 * Editing: keep the curly quotes and arrows. `{token}` placeholders are filled from settings and env when the page
 * renders (content/docs/values.ts lists them); never hard-code those numbers. Pure and client-safe.
 */

export const DOC_GROUPS = ["Getting started", "Licensing", "Using the software", "Troubleshooting"] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];

/** Operating systems with their own install steps (the OS tabs). */
export const DOC_PLATFORMS = ["windows", "macos"] as const;
export type DocPlatform = (typeof DOC_PLATFORMS)[number];
export const DOC_PLATFORM_LABELS: Readonly<Record<DocPlatform, string>> = { windows: "Windows", macos: "macOS" };

export type DocStep = {
  title: string;
  body: string;
  /** Optional monospace chip under the step (file name, key format). */
  code?: string;
};

type DocGuideBase = {
  /** URL segment: /docs/<slug>. Support FAQs and the footer link to these, so renaming one breaks links. */
  slug: string;
  group: DocGroup;
  title: string;
  /** One sentence under the title; also the page description. */
  summary: string;
  /** Optional callout after the steps. */
  note?: string;
};

/** A guide has either one list of steps or one list per operating system. */
export type DocGuide = DocGuideBase &
  (
    | { steps: readonly DocStep[]; platformSteps?: never }
    | { platformSteps: Readonly<Record<DocPlatform, readonly DocStep[]>>; steps?: never }
  );

export const DOC_GUIDES: readonly DocGuide[] = [
  {
    slug: "getting-started",
    group: "Getting started",
    title: "Before you begin",
    summary: "What you need to install and run Axiomatic software.",
    steps: [
      {
        title: "Check system requirements",
        body: "Each product page lists the operating system, memory and disk space needed.",
      },
      {
        title: "Keep your license key handy",
        body: "You’ll find it in your order email and under Licenses in your account.",
      },
      {
        title: "Plan your computers",
        body: "Each license covers a set number of devices. Install on the computers you bill from first.",
      },
      {
        title: "Have an internet connection",
        body: "Needed once to activate and later to download updates. Billing works offline.",
      },
    ],
  },
  {
    slug: "install",
    group: "Getting started",
    title: "Install the software",
    summary: "Download the installer from your account and run it on each billing computer.",
    platformSteps: {
      windows: [
        {
          title: "Download the installer",
          body: "Sign in, open Software & downloads and choose the Windows download. Links expire after {downloadLinkTime}, so start the download right away.",
        },
        {
          title: "Run setup",
          body: "Open the downloaded file. If Windows asks for permission, choose Yes.",
          code: "{windowsInstaller}",
        },
        { title: "Choose a folder", body: "Keep the default folder unless you have a reason to change it." },
        { title: "Finish and open", body: "Select Finish. The software opens on the activation screen." },
      ],
      macos: [
        {
          title: "Download the installer",
          body: "Sign in, open Software & downloads and choose the macOS download.",
        },
        {
          title: "Open the disk image",
          body: "Double-click the .dmg file and drag the app into Applications.",
          code: "{macInstaller}",
        },
        { title: "Allow the app", body: "The first time, right-click the app, choose Open, then confirm." },
        { title: "Open the app", body: "It starts on the activation screen." },
      ],
    },
  },
  {
    slug: "activate",
    group: "Licensing",
    title: "Activate your license",
    summary: "Link an installation to your license key. Each activation uses one device slot.",
    steps: [
      {
        title: "Copy your key",
        body: "In your account, open Licenses, choose the license, select Reveal and enter your account password, then Copy.",
      },
      {
        title: "Paste the key",
        body: "In the software, open Activate license and paste the key.",
        code: "{licenseKeyExample}",
      },
      { title: "Name this computer", body: "Give it a name you’ll recognise later, like “Counter PC”." },
      {
        title: "Confirm",
        body: "The software checks the key with our server. You’ll see the computer under Devices in your account.",
      },
    ],
    note: "If you see “activation limit reached”, every device slot is in use. Deactivate an old computer from your account or add a computer to the license.",
  },
  {
    slug: "move",
    group: "Licensing",
    title: "Move to a new computer",
    summary: "Free up a device slot from your old computer and activate on the new one.",
    steps: [
      { title: "Back up your data", body: "On the old computer, use Settings → Backup to save a backup file." },
      {
        title: "Deactivate the old computer",
        body: "In your account, open the license, go to Devices and select Deactivate. You get {selfServiceResets} a year.",
      },
      { title: "Install and activate", body: "Install on the new computer and activate with the same key." },
      { title: "Restore your data", body: "Use Settings → Restore and choose your backup file." },
    ],
    note: "If the old computer no longer works, raise a ticket. Support can reset devices after confirming your purchase.",
  },
  {
    slug: "renew",
    group: "Licensing",
    title: "Renewals and updates",
    summary: "How renewals extend your license and when you can download new versions.",
    steps: [
      {
        title: "Annual & subscription",
        body: "Renewing extends the end date from your current end date, so you never lose days by renewing early.",
      },
      {
        title: "One-time licenses",
        body: "Updates are included for {updatesPeriod}. Renew maintenance to download versions released after that.",
      },
      {
        title: "Check what you can download",
        body: "Software & downloads shows the newest version each license allows.",
      },
    ],
  },
  {
    slug: "backup",
    group: "Using the software",
    title: "Back up and restore",
    summary: "Protect your billing data with regular backups.",
    steps: [
      {
        title: "Turn on automatic backup",
        body: "Settings → Backup → Daily backup. Choose a folder on a different drive or a USB disk.",
      },
      { title: "Make a manual backup", body: "Use Back up now before updates or moving computers." },
      { title: "Restore", body: "Settings → Restore, choose the file and confirm. The software restarts." },
    ],
    note: "Your billing data is stored on your computer. We can’t recover it for you, so keep backups somewhere safe.",
  },
  {
    slug: "printers",
    group: "Using the software",
    title: "Set up printers",
    summary: "Connect thermal, A5 or A4 printers for bills and KOTs.",
    steps: [
      {
        title: "Install the printer driver",
        body: "Use the driver from the printer maker and print a Windows test page first.",
      },
      { title: "Choose the printer", body: "Settings → Print → choose the printer and paper size." },
      { title: "Print a test bill", body: "Use Print sample. Adjust margins if text is cut off." },
    ],
  },
  {
    slug: "troubleshooting",
    group: "Troubleshooting",
    title: "Common problems",
    summary: "Quick fixes for the issues we see most often.",
    steps: [
      {
        title: "“Activation limit reached”",
        body: "All device slots are in use. Deactivate a computer from your account, or add one.",
      },
      {
        title: "“License expired”",
        body: "Renew from your account. The software unlocks the next time it checks your license after payment is confirmed: restart it, or connect it to the internet if it has been offline.",
      },
      {
        title: "“Can’t reach the license server”",
        body: "Check the internet connection. Activated copies keep working offline for {offlineGrace} between checks.",
      },
      {
        title: "Barcode scanner types nothing",
        body: "Check Settings → Devices → Barcode input and make sure keyboard mode is on.",
      },
    ],
  },
];

/** /docs redirects here. */
export const FIRST_GUIDE_SLUG = "getting-started";

export function guideHref(slug: string): string {
  return `/docs/${encodeURIComponent(slug)}`;
}

export function findGuide(slug: string): DocGuide | null {
  return DOC_GUIDES.find((guide) => guide.slug === slug) ?? null;
}

/** Items grouped for the sidebar, in DOC_GROUPS order (empty groups left out; item order kept). */
export function groupByDocGroup<T extends { group: DocGroup }>(items: readonly T[]): { label: DocGroup; items: T[] }[] {
  return DOC_GROUPS.map((label) => ({ label, items: items.filter((item) => item.group === label) })).filter(
    (group) => group.items.length > 0,
  );
}
