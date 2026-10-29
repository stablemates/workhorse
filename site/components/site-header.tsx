import { useRouterState } from "@tanstack/react-router";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import { useTheme } from "fumadocs-ui/provider/base";
import { useEffect, useId, useRef, useState } from "react";

import markSvg from "../public/brand/workhorse-mark.svg?raw";
import wordmarkSvg from "../public/brand/workhorse-wordmark.svg?raw";
import { hasPosts } from "@/lib/blog";
import { siteConfig } from "@/lib/site";
import { currentNavItem, headerIcons, siteNavItems, type SiteNavItem } from "@/lib/site-nav";

const items = siteNavItems({ hasPosts });

function Icon({ svg, className = "" }: { readonly svg: string; readonly className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function NavLink({ item, current }: { readonly item: SiteNavItem; readonly current: boolean }) {
  const external = item.match.kind === "external";
  return (
    <a
      className="wh-hdr-link"
      href={item.href}
      aria-current={current ? "page" : undefined}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
    >
      {item.label}
      {external ? <Icon svg={headerIcons.external} className="wh-hdr-ext" /> : null}
    </a>
  );
}

/**
 * The header of the TanStack Start pages. `blume/components/Header.astro`
 * renders the same markup on the documentation pages, and both read
 * `lib/site-nav.ts` and `site-header.css`, which `src/styles/global.css`
 * imports. Change the two together.
 *
 * The page path decides the current item. Below 1024px the items move into a
 * menu that the last button opens.
 */
export function SiteHeader() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const current = currentNavItem(items, path);
  const { setOpenSearch } = useSearchContext();
  const { resolvedTheme, setTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const panelId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);

  // Escape closes the open menu and returns focus to the button that opened it.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <header className="wh-hdr" data-wh-header>
      <a className="wh-hdr-brand" href="/" aria-label="Workhorse home">
        <Icon svg={markSvg} className="wh-hdr-mark" />
        <Icon svg={wordmarkSvg} className="wh-hdr-wordmark" />
      </a>
      <nav className="wh-hdr-nav" aria-label="Main">
        {items.map((item) => (
          <NavLink key={item.label} item={item} current={item === current} />
        ))}
      </nav>
      <div className="wh-hdr-actions">
        <button
          type="button"
          className="wh-hdr-icon"
          aria-label="Search"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={() => setOpenSearch(true)}
        >
          <Icon svg={headerIcons.search} />
        </button>
        <button
          type="button"
          className="wh-hdr-icon"
          aria-label="Toggle the colour scheme"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          <Icon svg={headerIcons.sun} className="wh-hdr-sun" />
          <Icon svg={headerIcons.moon} className="wh-hdr-moon" />
        </button>
        <a
          className="wh-hdr-icon"
          href={siteConfig.github}
          aria-label="Workhorse on GitHub"
          target="_blank"
          rel="noreferrer noopener"
        >
          <Icon svg={headerIcons.github} />
        </a>
        <button
          ref={menuButton}
          type="button"
          className="wh-hdr-icon wh-hdr-menu"
          aria-label="Menu"
          aria-controls={panelId}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon svg={headerIcons.menu} />
        </button>
      </div>
      <nav id={panelId} className="wh-hdr-panel" aria-label="Menu" hidden={!menuOpen}>
        {items.map((item) => (
          <NavLink key={item.label} item={item} current={item === current} />
        ))}
      </nav>
    </header>
  );
}
