import { Outlet, createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";

import { baseOptions } from "@/app/layout.config";
import { SiteFooter } from "@/components/site-footer";

export const Route = createFileRoute("/compare")({
  component: CompareLayout,
});

/**
 * The comparison pages are site pages (ADR 0116). They share the header and
 * the footer of the landing page, and each one is prerendered with its own
 * title, description, and canonical URL.
 */
function CompareLayout() {
  return (
    <div className="flex flex-1 flex-col">
      <HomeLayout {...baseOptions} className="flex-1">
        <Outlet />
        <SiteFooter />
      </HomeLayout>
    </div>
  );
}
