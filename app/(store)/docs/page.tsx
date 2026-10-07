import { redirect } from "next/navigation";
import { FIRST_GUIDE_SLUG, guideHref } from "@/content/docs/guides";

/** /docs has no page of its own: it opens the first guide (docs/decisions.md > Phase 2). */
export default function DocsIndexPage(): never {
  redirect(guideHref(FIRST_GUIDE_SLUG));
}
