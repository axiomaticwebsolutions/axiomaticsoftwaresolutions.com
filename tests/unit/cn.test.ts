import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins conditional classes", () => {
    expect(cn("bg-primary", false, undefined, "hover:bg-primary-hover")).toBe("bg-primary hover:bg-primary-hover");
  });

  it("keeps a custom font size next to a text colour", () => {
    expect(cn("text-overline", "text-ink-2")).toBe("text-overline text-ink-2");
    expect(cn("text-display uppercase", "text-primary-link")).toBe("text-display uppercase text-primary-link");
  });

  it("lets a later custom font size win", () => {
    expect(cn("text-display", "text-h2")).toBe("text-h2");
    expect(cn("text-[15px]", "text-overline")).toBe("text-overline");
  });

  it("resolves token radii and shadows", () => {
    expect(cn("rounded-12", "rounded-8")).toBe("rounded-8");
    expect(cn("rounded-pill", "rounded-14")).toBe("rounded-14");
    expect(cn("shadow-menu", "shadow-dialog")).toBe("shadow-dialog");
    expect(cn("shadow-primary", "shadow-none")).toBe("shadow-none");
  });

  it("lets padding shorthands override axis padding", () => {
    expect(cn("px-[18px] py-[11px]", "p-0")).toBe("p-0");
  });

  it("does not merge colours of different tones on different properties", () => {
    expect(cn("bg-lavender-bg text-lavender-fg", "border-lavender-line")).toBe(
      "bg-lavender-bg text-lavender-fg border-lavender-line",
    );
    expect(cn("bg-lavender-bg", "bg-sage-bg")).toBe("bg-sage-bg");
  });
});
