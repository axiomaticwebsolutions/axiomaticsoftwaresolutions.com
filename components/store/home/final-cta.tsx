import Link from "next/link";
import { Container } from "@/components/store/container";
import { Button } from "@/components/ui/button";
import { HOME_CTAS, HOME_FINAL_CTA } from "@/content/home";
import { demoHref } from "@/lib/storefront/derive";
import { cn } from "@/lib/utils";
import { WRAP } from "./styles";

/** Lavender closing panel with decorative circles and the two CTAs (Home.dc.html section 8). Server. */
export function FinalCta() {
  return (
    <Container as="section" aria-labelledby="cta-h" className="py-[clamp(56px,7vw,96px)]">
      <div className="relative flex flex-wrap items-center justify-between gap-7 overflow-hidden rounded-32 bg-lavender-bg p-[clamp(36px,6vw,72px)]">
        <div aria-hidden="true" className="absolute -top-20 -right-20 size-80 rounded-full bg-pink-bg" />
        <div aria-hidden="true" className="absolute right-[120px] -bottom-[140px] size-[260px] rounded-full bg-blue-bg" />
        <div className="relative max-w-[560px]">
          <h2
            id="cta-h"
            className={cn("m-0 text-[clamp(30px,3.6vw,46px)] leading-[1.08] font-extrabold tracking-[-0.035em]", WRAP)}
          >
            {HOME_FINAL_CTA.title}
          </h2>
          <p className="mt-3.5 mb-0 text-[17px] leading-[1.6] text-ink-body">{HOME_FINAL_CTA.body}</p>
        </div>
        <div className="relative flex flex-wrap gap-3">
          <Button asChild size="lg" className="leading-[normal] shadow-none">
            <Link href="/software">{HOME_CTAS.explore}</Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="secondary"
            className="border-0 leading-[normal] hover:text-primary-link"
          >
            <Link href={demoHref()}>{HOME_CTAS.demo}</Link>
          </Button>
        </div>
      </div>
    </Container>
  );
}
