import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";

import { baseOptions } from "@/app/layout.config";
import { SiteFooter } from "@/components/site-footer";

/*
 * The page shell of the marketing pages. The classes are in
 * `src/styles/marketing.css`. A page is a list of `Section`s on one neutral
 * canvas. Space separates the sections; no line, rail, or label strip does.
 */

/**
 * A marketing page: the site header, the content, and the footer. The
 * controls of the content draw their colors from site stylesheet rules, not
 * from a theme provider, so the first paint already has the colors of the
 * scheme.
 */
export function MarketingPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <HomeLayout {...baseOptions} className="flex-1 bg-wh-page">
        <div className="wh-marketing overflow-x-clip">{children}</div>
        <SiteFooter />
      </HomeLayout>
    </div>
  );
}

/**
 * One section of a marketing page, in the page container (`.wh-container`).
 * The closing call and the footer use the same container, so their edges line
 * up with every section.
 */
export function Section({
  id,
  className = "",
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`wh-container scroll-mt-16 py-20 sm:py-28 ${className}`}>
      {children}
    </section>
  );
}

/**
 * The centered head of a section: a headline in the foreground color, one or
 * two sentences of context, and an optional link.
 */
export function SectionHead({
  title,
  lede,
  link,
  as: Heading = "h2",
}: {
  title: ReactNode;
  lede?: ReactNode;
  link?: ReactNode;
  as?: "h1" | "h2";
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
      <Heading className="wh-title text-balance font-semibold text-wh-fg">{title}</Heading>
      {lede ? (
        <p className="mt-5 max-w-2xl text-pretty text-ui-m text-wh-muted sm:text-[1.125rem] sm:leading-7 [&_code]:font-mono [&_code]:text-[0.875em] [&_code]:text-wh-fg">
          {lede}
        </p>
      ) : null}
      {link ? <div className="mt-6">{link}</div> : null}
    </div>
  );
}
