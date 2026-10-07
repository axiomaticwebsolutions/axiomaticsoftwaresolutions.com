"use client";

import * as React from "react";
import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Demo, DemoGrid } from "@/app/dev/ui/section";

const VARIANTS: readonly ButtonVariant[] = [
  "primary",
  "secondary",
  "ghost",
  "link",
  "destructive",
  "destructive-outline",
  "warning",
  "dark",
  "subtle",
];

/** Buttons in every variant, size and state (hover/focus are live; a simulated focus ring is shown too). */
export function ButtonDemos() {
  const [busy, setBusy] = React.useState(false);

  function simulate() {
    setBusy(true);
    window.setTimeout(() => setBusy(false), 1600);
  }

  return (
    <DemoGrid>
      <Demo title="Variants (hover me)">
        <div className="flex flex-wrap items-center gap-3">
          {VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
        </div>
      </Demo>

      <Demo title="Sizes">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small (admin)</Button>
          <Button size="md">Request a demo</Button>
          <Button size="lg">Explore Software</Button>
          <Button size="lg" variant="secondary">
            Request a Demo
          </Button>
          <Button size="icon" variant="secondary" aria-label="Open cart">
            <Icon name="shopping_bag" size={20} />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="More actions">
            <Icon name="more_vert" size={18} />
          </Button>
        </div>
      </Demo>

      <Demo title="States">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Default</Button>
          <Button className="outline-2 outline-offset-2 outline-primary">Focus (simulated)</Button>
          <Button disabled>Disabled</Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <Button loading loadingText="Processing…">
            Pay ₹3,539
          </Button>
          <Button variant="secondary" loading>
            Saving
          </Button>
        </div>
        <p className="text-[13px] text-ink-2">Press Tab to see the real focus ring (2px primary outline, 2px offset).</p>
      </Demo>

      <Demo title="Loading on click, icons, asChild">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={simulate} loading={busy} loadingText="Adding…">
            <Icon name="shopping_cart_checkout" size={20} />
            Add to cart
          </Button>
          <Button asChild variant="secondary">
            <Link href="#buttons">
              View details
              <Icon name="arrow_forward" size={18} />
            </Link>
          </Button>
          <Button asChild variant="link">
            <Link href="#buttons">Text link button</Link>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Spinner label="Loading" />
          <Spinner size="lg" label="Loading" />
          <span className="inline-flex items-center gap-2 rounded-12 bg-primary px-3 py-2 text-white">
            <Spinner tone="onPrimary" size="sm" /> on primary
          </span>
        </div>
      </Demo>
    </DemoGrid>
  );
}
