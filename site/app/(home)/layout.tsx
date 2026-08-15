import type { ReactNode } from "react";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/app/layout.config";
import { SiteFooter } from "@/components/site-footer";

/**
 * Shell for every non-docs route. Sharing one layout keeps the marketing,
 * reference, integrations, examples, and demo pages on the same header,
 * footer, and container rhythm.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <HomeLayout {...baseOptions} className="flex-1">
      {children}
      <SiteFooter />
    </HomeLayout>
  );
}
