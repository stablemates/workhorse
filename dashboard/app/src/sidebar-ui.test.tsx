import { readFileSync } from "node:fs";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import type { DashboardSidebarProps } from "./shell/Sidebar.js";

const stored = new Map<string, string>();
let storageFails = false;
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storageFails) throw new Error("Storage is blocked");
      stored.set(key, value);
    },
  },
});

// Imported after the stub above because these modules read stored preferences on evaluation.
const { GraphicalProvider, theme } = await import("./ui.js");
const {
  DashboardSidebar,
  helpMenuEntries,
  isNavigationShortcut,
  navigationShortcut,
  readStoredSidebarCollapsed,
  storeSidebarCollapsed,
} = await import("./shell/Sidebar.js");

const controllerSource = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("./shell/AppShell.tsx", import.meta.url), "utf8");

function render(props: Partial<DashboardSidebarProps> = {}): string {
  const sidebar: DashboardSidebarProps = {
    location: { route: "/tasks" },
    basePath: "/ops",
    onNavigate: () => undefined,
    collapsed: false,
    ...props,
  };
  const tree: ReactNode = createElement(DashboardSidebar, sidebar);
  return renderToStaticMarkup(
    createElement(GraphicalProvider, { document: theme, colorMode: "light" }, tree),
  );
}

/** The markup of the one link whose visible label is `label`. */
function linkFor(html: string, label: string): string {
  const links = html.match(/<a\b[^>]*>(?:(?!<\/a>).)*<\/a>/g) ?? [];
  const found = links.filter((link) =>
    link.includes(`<span class="dashboard-sidebar__label">${label}</span>`),
  );
  expect(found, `one link labeled ${label}`).toHaveLength(1);
  return found[0]!;
}

describe("sidebar collapse preference", () => {
  beforeEach(() => {
    stored.clear();
    storageFails = false;
  });

  it("starts expanded and keeps the stored choice", () => {
    expect(readStoredSidebarCollapsed()).toBe(false);
    storeSidebarCollapsed(true);
    expect(stored.get("workhorse-sidebar-collapsed")).toBe("true");
    expect(readStoredSidebarCollapsed()).toBe(true);
    storeSidebarCollapsed(false);
    expect(readStoredSidebarCollapsed()).toBe(false);
  });

  it("reads an unknown stored value as expanded", () => {
    stored.set("workhorse-sidebar-collapsed", "yes");
    expect(readStoredSidebarCollapsed()).toBe(false);
  });

  it("keeps the choice for the session when the browser blocks storage", () => {
    storageFails = true;
    storeSidebarCollapsed(true);
    expect(readStoredSidebarCollapsed()).toBe(true);
    storeSidebarCollapsed(false);
  });
});

describe("expanded sidebar", () => {
  it("lists the top-level pages as one flat list, with no status views or counts", () => {
    const html = render();
    const labels = [
      ...html.matchAll(/<span class="dashboard-sidebar__label">([^<]+)<\/span>/g),
    ].map((match) => match[1]);

    expect(labels).toEqual([
      "Tasks",
      "Events",
      "Task groups",
      "Schedules",
      "Queues",
      "Workers",
      "System health",
      "Settings",
      "Help",
    ]);
    for (const label of ["All tasks", "Blocked", "Waiting", "Canceled"]) {
      expect(html).not.toContain(`>${label}<`);
    }
    expect(html).not.toContain("dashboard-sidebar__count");
    expect(html).not.toContain("data-nested");
  });

  it("gives every page one 16px icon with one stroke weight", () => {
    const html = render();
    for (const label of ["Tasks", "Events", "Workers", "System health", "Settings"]) {
      const link = linkFor(html, label);
      expect(link.match(/<svg/g)).toHaveLength(1);
      expect(link).toContain('width="16" height="16"');
      expect(link).toContain('stroke-width="1.5"');
    }
  });

  it("marks Tasks as the current page on the task list", () => {
    const html = render({ location: { route: "/tasks" } });
    expect(linkFor(html, "Tasks")).toContain('href="/ops/tasks"');
    expect(linkFor(html, "Tasks")).toContain('aria-current="page"');
  });

  it("links each page under the mounted base path, as navigation and not tabs", () => {
    const html = render({ location: { route: "/queues" } });

    expect(html).toContain('<nav class="dashboard-sidebar"');
    expect(html).not.toContain('role="tab');
    for (const [label, path] of [
      ["Events", "/ops/events"],
      ["Task groups", "/ops/groups"],
      ["Schedules", "/ops/cron"],
      ["Queues", "/ops/queues"],
      ["Workers", "/ops/workers"],
      ["System health", "/ops/system"],
      ["Settings", "/ops/settings"],
    ] as const) {
      expect(linkFor(html, label)).toContain(`href="${path}"`);
    }
    expect(linkFor(html, "Queues")).toContain('aria-current="page"');
    expect(html).toContain('href="/ops/" aria-label="Workhorse home"');
  });

  it("has no section headings, divider, Documentation row, or beta badge", () => {
    const html = render({ version: "0.10.0", revision: "cfacba3f00" });

    expect(html).not.toContain(">Operations<");
    expect(html).not.toContain("mantine-Divider");
    expect(html).not.toMatch(/beta/i);
    expect(html).not.toContain(">Documentation<");
    expect(html).toContain('<span class="dashboard-sidebar__label">Help</span>');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("keeps the version out of the footer, because the Help menu states it", () => {
    const html = render({ version: "0.10.0", revision: "cfacba3f00" });

    expect(html).not.toContain("v0.10.0");
    expect(html).not.toContain("workhorse-version");
    expect(html).not.toContain("cfacba3");
    // The footer holds Settings and Help only.
    const footer = html.slice(html.indexOf('class="dashboard-sidebar__footer"'));
    expect(
      [...footer.matchAll(/<span class="dashboard-sidebar__label">([^<]+)<\/span>/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["Settings", "Help"]);
  });

  it("shows the workspace control under the brand", () => {
    const html = render({ workspaceControl: createElement("button", null, "production") });
    expect(html).toContain(
      '<div class="dashboard-sidebar__workspace"><button>production</button></div>',
    );
  });

  it("has no collapse button of its own, because the header toggle collapses it", () => {
    expect(render()).not.toContain("Collapse sidebar");
    expect(render({ collapsed: true })).not.toContain("Expand sidebar");
  });

  it("starts to load a page when a pointer or the focus reaches its link", () => {
    const sidebarSource = readFileSync(new URL("./shell/Sidebar.tsx", import.meta.url), "utf8");
    expect(sidebarSource).toContain("onPointerEnter={prefetch}");
    expect(sidebarSource).toContain("onFocus={prefetch}");
    expect(shellSource).toContain("onPrefetch: (href: string) => void prefetchPage(href),");
  });
});

describe("collapsed rail", () => {
  const html = render({
    collapsed: true,
    version: "0.10.0",
    revision: "cfacba3f00",
    workspaceControl: createElement("button", null, "production"),
  });

  it("names each icon-only item for assistive technology", () => {
    expect(html).toContain("data-rail");
    for (const label of ["Tasks", "Events", "Task groups", "Schedules", "Queues", "Workers"]) {
      expect(linkFor(html, label)).toContain(`aria-label="${label}"`);
    }
    expect(linkFor(html, "System health")).toContain('aria-label="System health"');
    expect(linkFor(html, "Settings")).toContain('aria-label="Settings"');
  });

  it("links Tasks directly instead of opening a menu of status views", () => {
    expect(linkFor(html, "Tasks")).toContain('href="/ops/tasks"');
    expect(html).not.toContain(">All tasks<");
  });

  it("keeps the brand mounted for the fade and keeps the workspace control in its place", () => {
    // The rail fades the wordmark with CSS instead of removing it, so the brand does not jump.
    expect(html).toContain('data-rail="true"');
    expect(html).toContain("workhorse-brand__wordmark");
    expect(html).not.toContain("workhorse-version");
    // The rail clips the control to its tile, so the rows under it do not move up.
    expect(html).toContain(
      '<div class="dashboard-sidebar__workspace"><button>production</button></div>',
    );
  });

  it("puts each icon in the box that the rail surface, tooltips, and menus use", () => {
    const rail = render({ collapsed: true });
    // Seven pages, Settings, and Help each have one 36px icon box in front of the label.
    expect(rail.match(/<span class="dashboard-sidebar__glyph">/g)).toHaveLength(9);
    expect(linkFor(rail, "Queues")).toMatch(
      /<span class="dashboard-sidebar__glyph"><svg[^>]*dashboard-sidebar__icon/,
    );
  });

  it("ignores the stored rail in the mobile drawer", () => {
    const drawer = render({ collapsed: true, variant: "drawer" });
    expect(drawer).not.toContain("data-rail");
    expect(drawer).toContain('aria-label="Close navigation"');
    expect(drawer).not.toContain("Collapse sidebar");
  });
});

function press(keys: Partial<Parameters<typeof isNavigationShortcut>[0]>) {
  return { key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...keys };
}

describe("navigation shortcut", () => {
  it("is Command-B on Apple platforms and Control-B on the others", () => {
    expect(isNavigationShortcut(press({ metaKey: true }), true)).toBe(true);
    expect(isNavigationShortcut(press({ key: "B", metaKey: true }), true)).toBe(true);
    expect(isNavigationShortcut(press({ ctrlKey: true }), true)).toBe(false);
    expect(isNavigationShortcut(press({ ctrlKey: true }), false)).toBe(true);
    expect(isNavigationShortcut(press({ metaKey: true }), false)).toBe(false);
    expect(navigationShortcut(true)).toEqual({ label: "⌘B", aria: "Meta+B" });
    expect(navigationShortcut(false)).toEqual({ label: "Ctrl+B", aria: "Control+B" });
  });

  it("ignores B alone and B with another modifier", () => {
    expect(isNavigationShortcut(press({}), false)).toBe(false);
    expect(isNavigationShortcut(press({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isNavigationShortcut(press({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isNavigationShortcut(press({ key: "n", ctrlKey: true }), false)).toBe(false);
  });

  it("toggles the navigation the same way as the header button, and names the keys there", () => {
    expect(shellSource).toContain("useNavigationShortcut(toggleNavigation);");
    expect(shellSource).toMatch(/onToggle=\{toggleNavigation\}\s+controls=\{navigationId\}/);
    expect(shellSource).toContain("shortcut={shortcut}");
  });
});

describe("Help menu", () => {
  it("links the documentation, then the version and its commit under About", () => {
    expect(helpMenuEntries("0.10.0", "cfacba3f00")).toEqual([
      expect.objectContaining({
        group: "help",
        label: "Documentation",
        href: "https://workhorse.run/docs",
      }),
      {
        group: "about",
        label: "Workhorse v0.10.0",
        detail: "cfacba3",
        href: "https://github.com/stablemates/workhorse/commit/cfacba3f00",
        title: "cfacba3f00",
        accessibleName: "Workhorse version 0.10.0, revision cfacba3f00",
      },
    ]);
  });

  it("shows a published release without a commit link", () => {
    expect(helpMenuEntries("0.10.0", undefined)[1]).toEqual({
      group: "about",
      label: "Workhorse v0.10.0",
      accessibleName: "Workhorse version 0.10.0",
    });
  });

  it("has no About entry when the build names no version", () => {
    expect(helpMenuEntries(undefined, undefined).map((entry) => entry.label)).toEqual([
      "Documentation",
    ]);
  });
});

describe("sidebar menus", () => {
  const sidebarSource = readFileSync(new URL("./shell/Sidebar.tsx", import.meta.url), "utf8");

  it("own Escape ahead of the task drawer", () => {
    const roots = sidebarSource.match(/<Menu\.Root[^>]*>/g) ?? [];
    expect(roots).toHaveLength(1);
    for (const root of roots) expect(root).toContain("onOpenChange={trackPopup}");
  });
});

describe("mobile navigation drawer", () => {
  it("closes after an in-app navigation and leaves a modified click to the browser", () => {
    expect(controllerSource).toMatch(/setLocation\(router\.push\(href\)\);\s*closeNavbar\(\);/);
    expect(controllerSource).toMatch(
      /if \(event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\) \{\s*return;/,
    );
    expect(shellSource).toMatch(/onNavigate: handleLink,/);
    expect(shellSource).toMatch(
      /<DashboardNavigationDrawer\s+\{\.\.\.sidebarProps\}\s+opened=\{navbarOpened\}/,
    );
  });

  it("gives the sidebar and the drawer the same workspace switcher", () => {
    expect(shellSource).toMatch(/workspaceControl: <WorkspaceSwitcher /);
    expect(shellSource).toMatch(/<DashboardSidebar\s+\{\.\.\.sidebarProps\}/);
    expect(shellSource).toMatch(/<DashboardNavigationDrawer\s+\{\.\.\.sidebarProps\}/);
  });

  it("replaces the sliding sidebar on narrow windows", () => {
    expect(shellSource).toContain("collapsed: { mobile: true }");
  });
});
