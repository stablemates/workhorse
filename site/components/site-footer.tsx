import { WorkhorseMark } from "@/components/logo";
import { demoUrl, siteConfig } from "@/lib/site";

const columns = [
  {
    label: "Documentation",
    links: [
      { href: "/docs", text: "Overview" },
      { href: "/docs/quickstart", text: "Quickstart" },
      { href: "/docs/installation", text: "Installation" },
      { href: "/docs/api", text: "API reference" },
    ],
  },
  {
    label: "Build",
    links: [
      { href: "/docs/drizzle", text: "Integrations" },
      { href: "/docs/examples", text: "Examples" },
      { href: "/docs/dashboard", text: "Dashboard" },
    ],
  },
  {
    label: "Project",
    links: [
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
            A PostgreSQL-native durable execution protocol. Evidence-first, and explicit about what
            it does not promise.
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
          <p className="font-mono text-[11.5px] text-fd-muted-foreground">
            PostgreSQL 15+ · Node 22+
          </p>
        </div>
      </div>
    </footer>
  );
}
