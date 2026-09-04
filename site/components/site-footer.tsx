import support from "../../support.json";

import { WorkhorseMark } from "@/components/logo";
import { hasPosts } from "@/lib/blog";
import { demoUrl, siteConfig } from "@/lib/site";

/**
 * The runtime floors, read from `support.json` rather than typed here.
 *
 * The footer states them on every page, and a floor that has been raised still
 * looks like a floor, so a hand-typed copy goes stale with nobody noticing. That
 * is the failure ADR 0058 removed from `/docs/releases`, and `support.json` is
 * the repository's source of truth for every minimum.
 *
 * All three SDK runtimes are named. Workhorse publishes a TypeScript, a Python,
 * and a Go line, so a line that named only Node left two of them off the one
 * sentence that says what Workhorse runs on.
 */
const runtimes = [
  `PostgreSQL ${support.support.postgres.minimum}+`,
  `Node ${support.support.node.minimum}+`,
  `Python ${support.support.python.minimum}+`,
  // `support.json` spells the Go floor as a full version, `1.25.0`. Every other
  // surface prints the language version a reader installs (support-matrix).
  `Go ${support.support.go.minimum.replace(/\.0$/, "")}+`,
].join(" · ");

const columns = [
  {
    label: "Documentation",
    links: [
      { href: "/docs", text: "Overview" },
      { href: "/docs/quickstart", text: "Quickstart" },
      { href: "/docs/installation", text: "Installation" },
      { href: "/docs/api", text: "API reference" },
      { href: "/llms.txt", text: "For AI agents" },
    ],
  },
  {
    label: "Build",
    links: [
      { href: "/docs/integrations", text: "Integrations" },
      { href: "/docs/examples", text: "Examples" },
      { href: "/docs/dashboard", text: "Dashboard" },
    ],
  },
  {
    label: "Project",
    links: [
      // The blog is linked only once it has a post, so an empty index never
      // reaches a reader (ADR 0052).
      ...(hasPosts ? [{ href: "/blog", text: "Blog" }] : []),
      { href: siteConfig.github, text: "GitHub", external: true },
      { href: siteConfig.npm, text: "npm", external: true },
      { href: demoUrl, text: "Hosted demo", external: true },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="wh-rule mt-8 border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-12 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,10rem))] lg:px-8">
        <div>
          <div className="flex items-center gap-2">
            <WorkhorseMark size={22} className="size-[22px]" />
            <span className="text-[14px] font-semibold tracking-tight">Workhorse</span>
          </div>
          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-fd-muted-foreground">
            A durable job queue for PostgreSQL. Evidence-first, and explicit about what it does not
            promise.
          </p>
        </div>

        {columns.map((column) => (
          <nav key={column.label} aria-label={column.label}>
            <p className="wh-mono-label">{column.label}</p>
            <ul className="mt-3 space-y-2">
              {column.links.map((link) => (
                <li key={link.text}>
                  <a
                    href={link.href}
                    {...("external" in link && link.external
                      ? { target: "_blank", rel: "noreferrer noopener" }
                      : {})}
                    className="text-[13.5px] text-fd-muted-foreground transition-colors hover:text-fd-foreground"
                  >
                    {link.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="wh-rule border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-5 lg:px-8">
          <p className="font-mono text-[11.5px] text-fd-muted-foreground">
            Public beta · Apache-2.0
          </p>
          <p className="font-mono text-[11.5px] text-fd-muted-foreground">{runtimes}</p>
        </div>
      </div>
    </footer>
  );
}
