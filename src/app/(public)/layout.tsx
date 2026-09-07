import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SiteFooter } from "@/features/marketplace/components/site-footer";
import { SiteHeader } from "@/features/marketplace/components/site-header";

export const metadata: Metadata = {
  title: {
    default: "Sauda Jasa — Discover Almaty boutiques",
    template: "%s — Sauda Jasa",
  },
  description:
    "Discover boutiques and local sellers across Almaty. Browse by category, search by name or Instagram, and find where to buy.",
};

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
