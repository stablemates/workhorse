import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";

import { StaticSearchDialog } from "@/components/search";
import { siteConfig } from "@/lib/site";
// oxlint-disable-next-line import/no-unassigned-import -- font faces are global side effects.
import "@fontsource-variable/geist";
// oxlint-disable-next-line import/no-unassigned-import -- font faces are global side effects.
import "@fontsource-variable/geist-mono";
import appCss from "@/src/styles/global.css?url";

const title = `${siteConfig.name} — ${siteConfig.tagline}`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title },
      { name: "description", content: siteConfig.description },
      { name: "application-name", content: siteConfig.name },
      {
        name: "keywords",
        content: [
          "postgresql job queue",
          "durable execution",
          "background jobs",
          "typescript queue",
          "transactional outbox",
          "dead letter redrive",
        ].join(", "),
      },
      { name: "robots", content: "index, follow" },
      { name: "theme-color", content: "#121212" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: siteConfig.name },
      { property: "og:url", content: siteConfig.url },
      { property: "og:title", content: title },
      { property: "og:description", content: siteConfig.description },
      { property: "og:image", content: siteConfig.socialImage },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:width", content: "512" },
      { property: "og:image:height", content: "512" },
      { property: "og:image:alt", content: "Workhorse horse mark" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: siteConfig.description },
      { name: "twitter:image", content: siteConfig.socialImage },
      { name: "twitter:image:alt", content: "Workhorse horse mark" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/icon.png" },
      { rel: "apple-touch-icon", href: "/apple-icon.png" },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-9NC8FKZPVB" />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-9NC8FKZPVB');`,
          }}
        />
      </head>
      <body className="flex min-h-screen flex-col bg-fd-background font-sans antialiased">
        <RootProvider search={{ SearchDialog: StaticSearchDialog }}>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
