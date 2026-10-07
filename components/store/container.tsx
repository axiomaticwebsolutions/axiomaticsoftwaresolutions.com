import type * as React from "react";
import { cn } from "@/lib/utils";

type ContainerTag = "div" | "section" | "header" | "footer" | "nav" | "article" | "aside";

export type ContainerProps = React.HTMLAttributes<HTMLElement> & {
  /** Element to render (default div). */
  as?: ContainerTag;
};

/**
 * Storefront page width: at most 1240px including 24px side padding (16px below 640px), i.e. 1192px of content.
 * Every composed prototype page sets `*{box-sizing:border-box}`, so its `max-width:1240px; padding:0 24px` container
 * puts the logo and content at x=44 in a 1280px window. Server-safe.
 */
export function Container({ as: Tag = "div", className, ...props }: ContainerProps) {
  return <Tag className={cn("mx-auto max-w-store px-4 sm:px-6", className)} {...props} />;
}
