import { describe, expect, it } from "vitest";

import { CLI_COMMANDS } from "../../typescript/core/src/cli/surface.js";
import {
  renderCliSection,
  renderMachineReadable,
  renderNotFoundJson,
  renderNotFoundMarkdown,
  renderWhenToUse,
} from "./agent-surfaces.js";

const site = { base: "https://workhorse.run", name: "Workhorse" };
const entryPoint = {
  title: "Workhorse for AI coding agents",
  url: "/docs/for-ai-agents",
  description: "Read the agent-facing documentation, then integrate one job.",
};
const installation = { title: "Installation", url: "/docs/installation", description: "Install." };
const limitations = { title: "Limitations", url: "/docs/limitations", description: "Boundaries." };
const api = { title: "API overview", url: "/docs/api", description: "The surface." };
const operations = { title: "Operations", url: "/docs/operations", description: "The map." };

describe("the 404 bodies", () => {
  it("point a Markdown reader at the index, the entry point, and the .md rule", () => {
    const body = renderNotFoundMarkdown(site, entryPoint, [
      {
        title: "Getting started",
        first: { title: "Quickstart", url: "/docs/quickstart", description: "" },
      },
    ]);
    expect(body.startsWith("# 404: this page does not exist\n")).toBe(true);
    for (const token of [
      "https://workhorse.run/llms.txt",
      "https://workhorse.run/docs/for-ai-agents.md",
      "https://workhorse.run/llms-full.txt",
      "https://workhorse.run/sitemap.xml",
      "https://workhorse.run/openapi.json",
      "Append `.md` to any page URL",
      "- Getting started: [Quickstart](https://workhorse.run/docs/quickstart.md)",
    ]) {
      expect(body).toContain(token);
    }
  });

  it("give a JSON reader a code, a message, a hint, and the same links", () => {
    const body = JSON.parse(renderNotFoundJson(site, entryPoint)) as {
      error: {
        code: string;
        status: number;
        message: string;
        hint: string;
        links: Record<string, string>;
      };
    };
    expect(body.error.code).toBe("not_found");
    expect(body.error.status).toBe(4_04);
    expect(body.error.message).toContain("Workhorse");
    expect(body.error.hint).toContain("llms.txt");
    expect(body.error.links).toEqual({
      llms: "https://workhorse.run/llms.txt",
      llmsFull: "https://workhorse.run/llms-full.txt",
      agents: "https://workhorse.run/docs/for-ai-agents.md",
      docs: "https://workhorse.run/docs.md",
      sitemap: "https://workhorse.run/sitemap.xml",
      openapi: "https://workhorse.run/openapi.json",
    });
  });
});

describe("the llms.txt sections", () => {
  it("state when to use Workhorse, the disqualifiers, and the integration steps", () => {
    const section = renderWhenToUse(site, { entryPoint, installation, limitations });
    expect(section.startsWith("## When to use Workhorse\n")).toBe(true);
    for (const token of [
      "same transaction",
      "at least once",
      "PostgreSQL is the only supported database",
      "no workflow definition language",
      "https://workhorse.run/docs/limitations.md",
      "https://workhorse.run/docs/for-ai-agents.md",
      "https://workhorse.run/docs/installation.md",
      "names no version",
      "deployment step",
    ]) {
      expect(section).toContain(token);
    }
  });

  it("list every CLI command the binary declares, and only those", () => {
    const section = renderCliSection(site, { api, operations });
    expect(section.startsWith("## Command line\n")).toBe(true);
    for (const command of CLI_COMMANDS) {
      expect(section).toContain(`- \`workhorse ${command.name}\`: `);
    }
    const listed = [...section.matchAll(/^- `workhorse ([^`]+)`: /gm)].map((match) => match[1]);
    expect(listed).toEqual(CLI_COMMANDS.map((command) => command.name));
    // The bare form resolves an unrelated npm package outside a Node project.
    expect(section).not.toMatch(/npx workhorse\b/);
    expect(section).toContain("npm exec --no -- workhorse");
    expect(section).toContain("no Homebrew formula and no PyPI script");
  });

  it("name the machine-readable files and the negotiation rule", () => {
    const section = renderMachineReadable(site);
    for (const token of [
      "https://workhorse.run/openapi.json",
      "https://workhorse.run/sitemap.xml",
      "https://workhorse.run/llms-full.txt",
      "`Accept: text/markdown`",
      "`Vary: Accept`",
      "404",
    ]) {
      expect(section).toContain(token);
    }
  });
});
