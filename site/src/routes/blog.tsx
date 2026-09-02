import { Outlet, createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";

import { baseOptions } from "@/app/layout.config";
import { SiteFooter } from "@/components/site-footer";

export const Route = createFileRoute("/blog")({
  component: BlogLayout,
});

/**
 * The blog shares the landing page's header and footer rather than the docs
 * sidebar: a post is read top to bottom, and the docs tree is not its table of
 * contents.
 */
function BlogLayout() {
  return (
    <div className="wh-page-scale flex flex-1 flex-col">
      <HomeLayout {...baseOptions} className="flex-1">
        <Outlet />
        <SiteFooter />
      </HomeLayout>
    </div>
  );
}
