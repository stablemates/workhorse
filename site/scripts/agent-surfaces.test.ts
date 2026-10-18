import { describe, expect, it } from "vitest";

import { CLI_COMMANDS } from "../../typescript/core/src/cli/surface.js";
import {
  compactMarkdownTables,
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
  description: "Read the agent-facing documentation, then integrate one task.",
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
    const section = renderCliSection(site, { api, installation, operations });
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
    // Every non-Node SDK reads this line to learn how its schema step runs.
    expect(section).toContain(
      "Python, Go, Rust, Ruby, Java, and Kotlin applications run it through Node",
    );
    expect(section).toContain("`schema.sql`");
    expect(section).toContain("https://workhorse.run/docs/installation.md");
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

describe("the llms-full.txt table compaction", () => {
  it("removes the alignment padding and keeps every cell", () => {
    const table = [
      "| Option    | Default | Rule                 |",
      "| --------- | ------: | :------------------: |",
      "| `retries` | 3       | Counts `a \\|   b` too |",
      "|    `ttl` |    none | Right-aligned        |",
    ].join("\n");
    expect(compactMarkdownTables(table)).toBe(
      [
        "| Option | Default | Rule |",
        "| --- | ---: | :---: |",
        "| `retries` | 3 | Counts `a \\|   b` too |",
        "| `ttl` | none | Right-aligned |",
      ].join("\n"),
    );
  });

  it("leaves a table inside a fence and every non-table line unchanged", () => {
    const body = [
      "Prose with  two spaces  |  a pipe.",
      "```rust",
      "|    items: Vec<Item>    | async move {",
      "```",
      "```markdown",
      "| Option    | Default |",
      "| --------- | ------- |",
      "```",
      "  | psql    | indented",
    ].join("\n");
    expect(compactMarkdownTables(body)).toBe(body);
  });

  it("keeps a data row of dashes after the separator row", () => {
    const table = ["| Pattern |", "| ------- |", "| ---------- |"].join("\n");
    expect(compactMarkdownTables(table)).toBe(
      ["| Pattern |", "| --- |", "| ---------- |"].join("\n"),
    );
  });

  it("leaves tilde fences and longer backtick fences unchanged", () => {
    const body = [
      "~~~md",
      "| a    | b    |",
      "| ---- | ---- |",
      "```",
      "| c    | d    |",
      "| ---- | ---- |",
      "~~~",
      "````markdown",
      "```",
      "| e    | f    |",
      "| ---- | ---- |",
      "```",
      "| g    | h    |",
      "| ---- | ---- |",
      "````",
    ].join("\n");
    expect(compactMarkdownTables(body)).toBe(body);
    const after = `${body}\n| i    | j    |\n| ---- | ---- |`;
    expect(compactMarkdownTables(after)).toBe(`${body}\n| i | j |\n| --- | --- |`);
  });

  it("leaves a block that has no separator row unchanged", () => {
    const body = ["|  Keep this  |  literal text.", "|  And this   |  too."].join("\n");
    expect(compactMarkdownTables(body)).toBe(body);
    expect(compactMarkdownTables("|  One line  |")).toBe("|  One line  |");
  });
});
