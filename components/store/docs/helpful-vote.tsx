"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Vote = "yes" | "no";

const BUTTON_CLASS =
  "cursor-pointer rounded-10 border border-line-input px-3 py-[7px] font-bold leading-[normal] text-ink transition-colors hover:border-primary";

/**
 * "Was this helpful?" Yes/No toggle buttons (aria-pressed) with a polite "Thanks for the feedback." status.
 * Client-only acknowledgement: nothing is sent or stored (render it with key={slug} so each guide starts unvoted).
 */
export function HelpfulVote() {
  const [vote, setVote] = React.useState<Vote | null>(null);
  const labelId = React.useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-2 text-[14px] font-bold">
      <span id={labelId}>Was this helpful?</span>
      <button
        type="button"
        aria-pressed={vote === "yes"}
        onClick={() => setVote("yes")}
        className={cn(BUTTON_CLASS, vote === "yes" ? "bg-sage-bg" : "bg-surface")}
      >
        Yes
      </button>
      <button
        type="button"
        aria-pressed={vote === "no"}
        onClick={() => setVote("no")}
        className={cn(BUTTON_CLASS, vote === "no" ? "bg-pink-bg" : "bg-surface")}
      >
        No
      </button>
      <span role="status" className="text-sage-fg">
        {vote ? "Thanks for the feedback." : ""}
      </span>
    </div>
  );
}
