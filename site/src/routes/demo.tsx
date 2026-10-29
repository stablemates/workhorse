import { createFileRoute } from "@tanstack/react-router";

import { MarketingPage, Section, SectionHead } from "@/components/frame";
import { ButtonLink } from "@/components/primitives";
import { demoUrl, siteConfig } from "@/lib/site";

const title = `Dashboard demo — ${siteConfig.name}`;

/*
 * `/demo` was the dashboard tour. The header "Demo" item now opens the live
 * demo (`demoUrl`), so this page only sends an old link there. The site is
 * static, so the page redirects with a refresh tag, not an HTTP status. Like
 * `/not-found`, it is prerendered but stays out of the sitemap and asks not to
 * be indexed.
 */
export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title },
      { name: "robots", content: "noindex" },
      { httpEquiv: "refresh", content: `0; url=${demoUrl}` },
    ],
    links: [{ rel: "canonical", href: demoUrl }],
  }),
  component: DemoRedirect,
});

/** A reader whose browser does not follow the refresh tag clicks through. */
function DemoRedirect() {
  return (
    <MarketingPage>
      <Section className="pt-14 sm:pt-20">
        <SectionHead
          as="h1"
          title="The live dashboard"
          lede="The demo dashboard runs on its own site. If it does not open, use the link below."
        />
        <div className="mt-8 flex justify-center">
          <ButtonLink href={demoUrl} variant="primary">
            Open the live dashboard
          </ButtonLink>
        </div>
      </Section>
    </MarketingPage>
  );
}
