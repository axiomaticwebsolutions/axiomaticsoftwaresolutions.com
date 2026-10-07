import { Suspense } from "react";
import type { Metadata } from "next";
import { chartColors, palette, radii, shadows, TONE_NAMES, tones } from "@/lib/design/tokens";
import { Logo, LogoMark } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { ICON_PATHS, type IconName } from "@/components/icons/registry";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { ButtonDemos } from "@/app/dev/ui/button-demos";
import { ControlDemos } from "@/app/dev/ui/control-demos";
import { DataTableDemos } from "@/app/dev/ui/data-table-demo";
import { FormDemo } from "@/app/dev/ui/form-demo";
import { LICENSE_STATES } from "@/app/dev/ui/license-states";
import { NavigationDemos } from "@/app/dev/ui/navigation-demos";
import { OverlayDemos } from "@/app/dev/ui/overlay-demos";
import { Demo, DemoGrid, GallerySection } from "@/app/dev/ui/section";

export const metadata: Metadata = {
  title: "UI gallery",
  robots: { index: false, follow: false },
};

type Swatch = { name: string; hex: string };

/** Flattens the nested palette into Tailwind class-style names (DEFAULT keeps the bare name). */
function flattenPalette(): Swatch[] {
  const toneKeys = new Set<string>(TONE_NAMES);
  const swatches: Swatch[] = [];
  for (const [group, value] of Object.entries(palette)) {
    if (toneKeys.has(group)) continue;
    if (typeof value === "string") {
      swatches.push({ name: group, hex: value });
      continue;
    }
    for (const [shade, hex] of Object.entries(value as Record<string, string>)) {
      swatches.push({ name: shade === "DEFAULT" ? group : `${group}-${shade}`, hex });
    }
  }
  return swatches;
}

const SECTIONS = [
  ["tokens", "Colour"],
  ["type", "Type"],
  ["shape", "Radii & shadows"],
  ["brand", "Brand"],
  ["icons", "Icons"],
  ["buttons", "Buttons"],
  ["controls", "Controls"],
  ["forms", "Forms"],
  ["status", "Status & content"],
  ["overlays", "Overlays"],
  ["navigation", "Tabs, accordion, table"],
  ["data-table", "Data table"],
] as const;

const BADGE_TONES: readonly BadgeTone[] = ["lavender", "sage", "blue", "peach", "pink", "slate", "outline", "primary"];

function SwatchTile({ name, hex }: Swatch) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="h-14 rounded-12 border border-line" style={{ backgroundColor: hex }} />
      <div className="min-w-0">
        <p className="break-all font-mono text-[12.5px] font-semibold">{name}</p>
        <p className="font-mono text-[12px] text-ink-2">{hex}</p>
      </div>
    </div>
  );
}

export default function UiGalleryPage() {
  const swatches = flattenPalette();
  const iconNames = Object.keys(ICON_PATHS) as IconName[];

  return (
    <main id="main" className="mx-auto grid max-w-admin gap-14 overflow-x-clip px-4 py-10 sm:px-6">
      <header className="grid gap-5">
        <Logo />
        <div className="grid gap-2">
          <p className="text-overline uppercase text-primary-link">Development only</p>
          <h1 className="text-[clamp(30px,4vw,44px)] font-extrabold leading-tight tracking-[-0.035em]">UI gallery</h1>
          <p className="max-w-[720px] text-[16px] text-ink-2">
            Every design token and UI primitive in its states. Tokens come from lib/design/tokens.ts; components live
            in components/ui. This route is a 404 in production.
          </p>
        </div>
        <nav aria-label="Gallery sections">
          <ul className="flex flex-wrap gap-2">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="inline-flex rounded-pill border border-line bg-surface px-3 py-1.5 text-[13.5px] font-bold text-ink-2 hover:border-primary-accent hover:text-ink"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <GallerySection
        id="tokens"
        title="Colour"
        description="Palette tokens with their Tailwind names (bg-*, text-*, border-*). Tone pairs all meet 4.5:1."
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,140px),1fr))] gap-4">
          {swatches.map((swatch) => (
            <SwatchTile key={swatch.name} {...swatch} />
          ))}
        </div>
        <h3 className="text-[17px] font-extrabold">Tones</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-4">
          {TONE_NAMES.map((tone) => {
            const t = tones[tone];
            return (
              <div key={tone} className="grid gap-2 rounded-16 border p-3" style={{ borderColor: t.line, backgroundColor: t.soft }}>
                <div className="rounded-10 px-3 py-2.5" style={{ backgroundColor: t.bg, color: t.fg }}>
                  <p className="text-[15px] font-extrabold capitalize">{tone}</p>
                  <p className="text-[13px] font-semibold">Aa fg on bg</p>
                </div>
                <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[11.5px] text-ink-2">
                  {(["bg", "fg", "soft", "line"] as const).map((key) => (
                    <div key={key} className="contents">
                      <dt>{`${tone}-${key}`}</dt>
                      <dd className="text-right">{t[key]}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          })}
        </div>
        <h3 className="text-[17px] font-extrabold">Chart colours</h3>
        <ol className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,120px),1fr))] gap-3">
          {chartColors.map((hex, index) => (
            <li key={hex} className="grid gap-1.5">
              <div className="h-10 rounded-10" style={{ backgroundColor: hex }} />
              <p className="font-mono text-[12px] text-ink-2">
                {index + 1}. {hex}
              </p>
            </li>
          ))}
        </ol>
      </GallerySection>

      <GallerySection id="type" title="Type" description="Manrope 400–800 for UI, JetBrains Mono for keys, IDs and codes.">
        <div className="grid gap-6 rounded-20 border border-line bg-surface p-4 sm:p-6">
          <div className="grid gap-1">
            <p className="font-mono text-[12px] text-ink-2">text-display · clamp(40px, 5.6vw, 68px) / 800 / −0.04em</p>
            <p className="text-display">Smart software for everyday business.</p>
          </div>
          <div className="grid gap-1">
            <p className="font-mono text-[12px] text-ink-2">text-h1-product · clamp(34px, 4.4vw, 54px) / 800</p>
            <p className="text-h1-product">Medical Store Billing Software</p>
          </div>
          <div className="grid gap-1">
            <p className="font-mono text-[12px] text-ink-2">text-h2 · clamp(28px, 3vw, 38px) / 800 / −0.03em</p>
            <p className="text-h2">Purchase, download, activate</p>
          </div>
          <div className="grid gap-1">
            <p className="font-mono text-[12px] text-ink-2">text-overline · 12px / 800 / 0.1em, uppercase</p>
            <p className="text-overline uppercase text-primary-link">Featured software</p>
          </div>
          <Separator />
          <div className="grid gap-3">
            <p className="text-[18px] font-extrabold">Card title · 18px / 800</p>
            <p className="text-[16px] leading-[1.6] text-ink-body">
              Body · 16px / 1.6. Bill medicines by batch in seconds, keep a watch on expiry dates and print GST invoices.
            </p>
            <p className="text-[14.5px] text-ink-2">Secondary · 14.5px ink-2 (7.5:1 on white).</p>
            <p className="text-[13.5px] font-semibold text-ink-2">Small · 13.5px / 600</p>
            <p className="font-mono text-[14px]">MED-••••-••••-••••-K8NM · AXS/26-27/1181 · ₹2,999</p>
          </div>
        </div>
      </GallerySection>

      <GallerySection id="shape" title="Radii & shadows">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,110px),1fr))] gap-4">
          {Object.entries(radii).map(([name, value]) => (
            <div key={name} className="grid gap-1.5">
              <div className="h-16 border-2 border-primary-accent bg-lavender-soft" style={{ borderRadius: value }} />
              <p className="font-mono text-[12px] text-ink-2">rounded-{name}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-6 rounded-20 bg-bg-admin p-4 sm:p-6">
          {Object.entries(shadows).map(([name, value]) => (
            <div key={name} className="grid gap-2">
              <div className="h-20 rounded-14 bg-surface" style={{ boxShadow: value }} />
              <p className="font-mono text-[12px] text-ink-2">shadow-{name}</p>
            </div>
          ))}
        </div>
      </GallerySection>

      <GallerySection id="brand" title="Brand">
        <DemoGrid>
          <Demo title="Full (header, footer)">
            <Logo />
          </Demo>
          <Demo title="Compact (checkout header)">
            <div className="flex items-center gap-4">
              <Logo variant="compact" />
              <LogoMark size={48} />
            </div>
          </Demo>
          <Demo title="On dark (admin sidebar)">
            <div className="rounded-14 bg-admin-sidebar p-4">
              <Logo onDark />
            </div>
          </Demo>
        </DemoGrid>
      </GallerySection>

      <GallerySection
        id="icons"
        title="Icons"
        description={`${iconNames.length} Material Symbols Rounded icons compiled by pnpm icons. Decorative by default; pass label for a meaningful icon.`}
      >
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,104px),1fr))] gap-2">
          {iconNames.map((name) => (
            <li
              key={name}
              className="grid min-w-0 justify-items-center gap-1.5 rounded-12 border border-line bg-surface px-1.5 py-3 text-center"
            >
              <Icon name={name} size={24} />
              <span className="w-full break-all font-mono text-[10.5px] leading-tight text-ink-2">{name}</span>
            </li>
          ))}
        </ul>
      </GallerySection>

      <GallerySection id="buttons" title="Buttons">
        <ButtonDemos />
      </GallerySection>

      <GallerySection id="controls" title="Controls">
        <ControlDemos />
      </GallerySection>

      <GallerySection
        id="forms"
        title="Forms"
        description="Submit to see inline errors (aria-invalid + aria-describedby) and the focused error summary with links to each field."
      >
        <FormDemo />
      </GallerySection>

      <GallerySection id="status" title="Status & content">
        <DemoGrid>
          <Demo title="Badges">
            <div className="flex flex-wrap gap-2">
              {BADGE_TONES.map((tone) => (
                <Badge key={tone} tone={tone}>
                  {tone}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="sage" size="sm">
                New
              </Badge>
              <Badge tone="primary" size="sm">
                Most chosen
              </Badge>
              <Badge tone="outline" size="sm">
                Placeholder screenshot
              </Badge>
            </div>
          </Demo>
          <Demo title="License status pills">
            <div className="flex flex-wrap gap-2">
              {Object.values(LICENSE_STATES).map((state) => (
                <StatusPill key={state.label} tone={state.tone} icon={state.icon} label={state.label} />
              ))}
            </div>
          </Demo>
          <Demo title="Skeleton (1.4s pulse)">
            <div aria-busy="true" className="grid gap-3">
              <span className="sr-only">Loading</span>
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-10" />
                <div className="grid flex-1 gap-2">
                  <Skeleton className="h-3.5 w-3/5" />
                  <Skeleton className="h-3 w-2/5" alt />
                </div>
              </div>
              <Skeleton className="h-24 rounded-14" />
            </div>
          </Demo>
          <Demo title="Breadcrumb, kbd, separator">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink href="#status">Home</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink href="#status">Software</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>Medical Store Billing</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <Separator />
            <p className="flex flex-wrap items-center gap-1.5 text-[14px] text-ink-2">
              Open search with <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>, close with <Kbd>Esc</Kbd>
            </p>
          </Demo>
        </DemoGrid>
        <DemoGrid>
          <Alert tone="info">
            <AlertTitle>Payment received</AlertTitle>
            <AlertDescription>We’re confirming it with your bank. This page updates automatically.</AlertDescription>
          </Alert>
          <Alert tone="success">
            <AlertTitle>License active</AlertTitle>
            <AlertDescription>Your key and download are ready below.</AlertDescription>
          </Alert>
          <Alert tone="warning" role="note">
            <AlertTitle>Renew before 12 Nov 2026</AlertTitle>
            <AlertDescription>Creating new bills needs an active license.</AlertDescription>
          </Alert>
          <Alert tone="danger">
            <AlertTitle>Payment failed</AlertTitle>
            <AlertDescription>No money was taken. Try again or use another method.</AlertDescription>
          </Alert>
          <Alert tone="lavender">
            <AlertDescription>You’re checking out as a guest. We’ll email your license and invoice.</AlertDescription>
          </Alert>
          <Alert tone="neutral" icon={null}>
            <AlertDescription>Neutral notice without an icon.</AlertDescription>
          </Alert>
        </DemoGrid>
        <DemoGrid>
          <Card>
            <CardHeader>
              <CardTitle>Card</CardTitle>
              <CardDescription>White, 1px line border, radius 20, no shadow at rest.</CardDescription>
            </CardHeader>
            <CardContent className="text-[14.5px] text-ink-body">Content area.</CardContent>
          </Card>
          <Card interactive className="relative">
            <CardHeader>
              <div className="grid size-11 place-items-center rounded-12 bg-sage-bg text-sage-fg">
                <Icon name="medication" size={24} />
              </div>
              <CardTitle>
                <a href="#status" className="after:absolute after:inset-0 focus-visible:outline-none">
                  Medical Store Billing
                </a>
              </CardTitle>
              <CardDescription>
                Interactive card: hover for the card shadow and accent border; Tab to the title for the focus ring.
              </CardDescription>
            </CardHeader>
            <CardFooter className="mt-5 text-[14px] font-bold text-primary-link">
              View details <Icon name="arrow_forward" size={18} />
            </CardFooter>
          </Card>
        </DemoGrid>
      </GallerySection>

      <GallerySection
        id="overlays"
        title="Overlays"
        description="Escape closes every overlay. Focus is trapped in modals and returns to the trigger on close."
      >
        <OverlayDemos />
      </GallerySection>

      <GallerySection id="navigation" title="Tabs, accordion, table">
        <NavigationDemos />
      </GallerySection>

      <GallerySection
        id="data-table"
        title="Data table"
        description="components/data-table: toolbar (search, filters, Clear, count, CSV), bulk bar, sortable headers with aria-sort, row links or row click, pagination, skeleton, empty and error states, stats row, and cards below 760px. List state in the URL via lib/url-state.ts."
      >
        {/* useSearchParams needs a Suspense boundary on a statically rendered page. */}
        <Suspense fallback={null}>
          <DataTableDemos />
        </Suspense>
      </GallerySection>
    </main>
  );
}
