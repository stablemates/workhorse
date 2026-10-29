import cargoManifest from "../../rust/Cargo.toml?raw";
import gemspec from "../../ruby/stablemates-workhorse.gemspec?raw";
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
 * Every SDK runtime is named. Workhorse carries a TypeScript, a Python, a Go, a
 * Rust, and a Ruby line, so a line that named only Node left four of them off the
 * one sentence that says what Workhorse runs on.
 *
 * The Rust floor is the crate's own `rust-version`, which Cargo enforces, so the
 * footer reads it from `rust/Cargo.toml` as the README alignment test does. The
 * Ruby floor is the gem's `required_ruby_version`, for the same reason.
 */
const rustVersion = /^rust-version = "([^"]+)"$/m.exec(cargoManifest)?.[1];
if (!rustVersion) throw new Error("rust/Cargo.toml declares no rust-version");
const rubyVersion = /^\s*spec\.required_ruby_version = ">= ([^"]+)"$/m.exec(gemspec)?.[1];
if (!rubyVersion)
  throw new Error("ruby/stablemates-workhorse.gemspec declares no required_ruby_version");

const runtimes = [
  { name: "PostgreSQL", floor: support.support.postgres.minimum },
  { name: "Node", floor: support.support.node.minimum },
  { name: "Python", floor: support.support.python.minimum },
  // `support.json` spells the Go floor as a full version, `1.25.0`. Every other
  // surface prints the language version a reader installs (support-matrix).
  { name: "Go", floor: support.support.go.minimum.replace(/\.0$/, "") },
  { name: "Rust", floor: rustVersion },
  { name: "Ruby", floor: rubyVersion },
] as const;

/**
 * The year of the build. The site is prerendered, so this is the year of the
 * last deploy, which is the year the published text last changed.
 */
const copyrightYear = new Date().getFullYear();

/**
 * The footer columns. Every internal link names a route that the build
 * prerenders, and every external link is a URL from `lib/site.ts`, so a
 * column cannot point at a page that does not exist.
 */
const columns = [
  {
    label: "Product",
    links: [
      { href: "/features", text: "Features" },
      { href: "/docs/dashboard", text: "Dashboard" },
      { href: "/docs/integrations", text: "Integrations" },
      { href: "/compare", text: "Compare" },
      { href: "/docs/releases", text: "Releases" },
      { href: demoUrl, text: "Live demo", external: true },
    ],
  },
  {
    label: "Documentation",
    links: [
      { href: "/docs", text: "Overview" },
      { href: "/docs/quickstart", text: "Quickstart" },
      { href: "/docs/installation", text: "Installation" },
      { href: "/docs/api", text: "API reference" },
      { href: "/docs/examples", text: "Examples" },
      { href: "/llms.txt", text: "For AI agents" },
    ],
  },
  {
    label: "Packages",
    links: [
      { href: siteConfig.github, text: "GitHub", external: true },
      { href: siteConfig.npm, text: "npm", external: true },
      { href: siteConfig.pypi, text: "PyPI", external: true },
      { href: siteConfig.goModule, text: "Go module", external: true },
      { href: siteConfig.crates, text: "crates.io", external: true },
    ],
  },
  {
    label: "Project",
    links: [
      // The blog is linked only once it has a post, so an empty index never
      // reaches a reader (ADR 0052).
      ...(hasPosts ? [{ href: "/blog", text: "Blog" }] : []),
      // The trust pages (ADR 0062) are linked from every page, because an agent
      // deciding whether a publisher is real looks for them by name in the footer.
      { href: "/about", text: "About" },
      { href: "/contact", text: "Contact" },
      { href: "/privacy", text: "Privacy" },
      { href: `${siteConfig.github}/security/policy`, text: "Security", external: true },
    ],
  },
] as const;

function FooterLink({ href, external, children }: FooterLinkProps) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      className="wh-footer-link"
    >
      {children}
    </a>
  );
}

interface FooterLinkProps {
  href: string;
  external: boolean;
  children: string;
}

/**
 * A small horse that lives on the footer wordmark. One drawing serves every
 * pose: the stylesheet moves its legs, head, and tail (`.wh-pony--<pose>` in
 * `src/styles/marketing.css`) and places it on a letter.
 */
function Pony({ pose }: { pose: "graze" | "hop" | "sleep" | "run" }) {
  return (
    <span className={`wh-pony wh-pony--${pose}`}>
      <span className="wh-pony__move">
        <svg viewBox="0 -3 42 34" fill="currentColor">
          <rect className="wh-pony__leg" x="11" y="16" width="3.2" height="11" rx="1.6" />
          <rect className="wh-pony__leg" x="15.4" y="16" width="3.2" height="11" rx="1.6" />
          <rect className="wh-pony__leg" x="23.6" y="16" width="3.2" height="11" rx="1.6" />
          <rect className="wh-pony__leg" x="28" y="16" width="3.2" height="11" rx="1.6" />
          <g className="wh-pony__upper">
            <path
              className="wh-pony__tail"
              d="M10.5 12.5C5 12 3 18 4.2 24.5c1.2-2.5 1.8-4 3-4.9-.2 1.9.2 3.4 1 4.4.4-4 1.4-6.4 3.8-8z"
            />
            <rect x="9" y="10" width="23.5" height="10" rx="5" />
            <g className="wh-pony__head">
              <path d="M24 14q2.5-7 5.6-11l5.4.6q-1.8 5.4-2.4 11.4z" />
              <path d="M29.2 2.6q2.8-3 6.2-1.4l4.2 4.8q1.2 2.6-1.2 3.6l-2.6.2q-2.2-.6-3.6-2.8z" />
              <path d="M30.4 2l.6-4.2 2.4 3.2z" />
              <path
                className="wh-pony__mane"
                d="M29.6 1.8Q25.4 6.4 23 12.6l2.6-.6-.2-1.8 2-.4-.2-2 2.2-.6.2-2 1.8-.8z"
              />
              <circle className="wh-pony__eye" cx="34.6" cy="4.2" r=".9" />
            </g>
          </g>
        </svg>
      </span>
    </span>
  );
}

/**
 * The site footer, in three bands on the page color (`.wh-footer` in
 * `src/styles/marketing.css`).
 *
 * 1. The mark, the position in one large line, and the runtime floors as a
 *    small table. Beside them, the four link groups.
 * 2. The copyright, the license, and the release stage.
 * 3. The wordmark at the full width of the container, in a quiet tone that
 *    fades into the bottom edge, with four small horses on its letters. It is
 *    decoration, so assistive technology skips it. The stylesheet draws the
 *    wordmark as a mask of the wordmark file, so its path is not in the HTML
 *    of every page.
 *
 * Every band uses the page container (`.wh-container`), so its edges line up
 * with the sections and the closing call.
 */
export function SiteFooter() {
  return (
    <footer className="wh-footer mt-auto">
      <div className="wh-container">
        <div className="grid gap-x-8 gap-y-14 pb-14 pt-16 lg:grid-cols-12 lg:pt-20">
          <div className="lg:col-span-5">
            <a href="/" className="inline-flex text-wh-fg" aria-label="Workhorse home">
              <WorkhorseMark size={28} className="size-7" />
            </a>
            <p className="wh-footer-line mt-6 max-w-sm text-balance">
              {siteConfig.tagline}, in eight languages.
            </p>
            <div className="mt-8">
              <p className="text-ui-xs text-wh-muted">Runs on</p>
              <dl className="wh-footer-runtimes mt-3">
                {runtimes.map((runtime) => (
                  <div key={runtime.name}>
                    <dt>{runtime.name}</dt>
                    <dd>{runtime.floor}+</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4 lg:col-span-7">
            {columns.map((column) => (
              <nav key={column.label} aria-label={column.label}>
                <p className="text-ui-xs text-wh-muted">{column.label}</p>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.text}>
                      <FooterLink href={link.href} external={"external" in link && link.external}>
                        {link.text}
                      </FooterLink>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-wh-line py-6 text-ui-xs text-wh-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© {copyrightYear} Stablemates</p>
          <p>
            <a
              href={`${siteConfig.github}/blob/main/LICENSE`}
              target="_blank"
              rel="noreferrer noopener"
              className="wh-footer-link wh-footer-license"
            >
              Apache-2.0
            </a>{" "}
            license · Public beta
          </p>
        </div>
      </div>

      <div className="wh-container">
        <div aria-hidden className="wh-footer-signature">
          <div className="wh-footer-wordmark" />
          <Pony pose="graze" />
          <Pony pose="hop" />
          <Pony pose="sleep" />
          <span className="wh-pony-snore">
            <span>z</span>
            <span>z</span>
            <span>z</span>
          </span>
          <Pony pose="run" />
        </div>
      </div>
    </footer>
  );
}
