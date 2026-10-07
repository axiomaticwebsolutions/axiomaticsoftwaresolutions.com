import type * as React from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/** Development-only tools (UI gallery). Every /dev route is a 404 in production builds. */
export default function DevLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}
