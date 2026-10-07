"use client";

import * as React from "react";

/**
 * Seconds left until `until` (epoch ms), ticking once a second; 0 when null or past. Used for the resend cooldown.
 */
export function useCountdown(until: number | null): number {
  const remaining = React.useCallback(() => (until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000))), [until]);
  const [left, setLeft] = React.useState(remaining);

  React.useEffect(() => {
    setLeft(remaining());
    if (until === null) return;
    const timer = window.setInterval(() => {
      const next = remaining();
      setLeft(next);
      if (next <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until, remaining]);

  return left;
}
