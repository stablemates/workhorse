import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GraphicalProvider, theme } from "./ui.js";
import {
  WorkspaceSwitcher,
  workspaceMenuEntries,
  type WorkspaceSwitcherProps,
} from "./shell/WorkspaceSwitcher.js";

function render(props: WorkspaceSwitcherProps): string {
  return renderToStaticMarkup(
    createElement(
      GraphicalProvider,
      { document: theme, colorMode: "light" },
      createElement(WorkspaceSwitcher, props),
    ),
  );
}

const workspaces = [
  {
    name: "production",
    url: "/workhorse/production",
    databaseHost: "db.internal:5432",
    databaseName: "workhorse_demo",
  },
  { name: "staging", url: "/workhorse/staging" },
];

describe("WorkspaceSwitcher", () => {
  it("names the current workspace on the trigger, without a prefix in its text", () => {
    const html = render({ workspaces, workspace: "staging" });
    expect(html).toContain('aria-label="Workspace: staging"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toMatch(/<span class="workspace-switcher__name">staging<\/span>/);
    expect(html).not.toContain(">Workspace<");
  });

  it("shows the database of the current workspace on a second line when the host names it", () => {
    expect(render({ workspaces, workspace: "production" })).toContain(
      '<span class="workspace-switcher__detail">db.internal:5432 · workhorse_demo</span>',
    );
    expect(render({ workspaces, workspace: "staging" })).not.toContain(
      "workspace-switcher__detail",
    );
  });

  it("links each workspace to its task list as a full document", () => {
    expect(workspaceMenuEntries({ workspaces, workspace: "staging" })).toEqual([
      {
        name: "production",
        href: "/workhorse/production/tasks",
        detail: "db.internal:5432 · workhorse_demo",
        current: false,
      },
      { name: "staging", href: "/workhorse/staging/tasks", detail: null, current: true },
    ]);
  });

  it("renders nothing in single-workspace mode", () => {
    expect(render({ workspaces: [], workspace: null })).not.toContain("<button");
    expect(render({ workspaces: [workspaces[0]!], workspace: "production" })).not.toContain(
      "<button",
    );
  });
});
