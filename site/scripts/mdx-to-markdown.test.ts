import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mdxToMarkdown } from "./mdx-to-markdown.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("the Markdown twin transform", () => {
  it("expands every tab inline under a bold language label", () => {
    const markdown = mdxToMarkdown(
      [
        "## Install",
        "",
        '<Tabs items={["TypeScript", "Python", "Go"]}>',
        '  <Tab value="TypeScript">',
        "",
        "    ```bash",
        "    npm install @stablemates/workhorse",
        "    ```",
        "",
        "  </Tab>",
        '  <Tab value="Python">',
        "    ```bash",
        "    pip install stablemates-workhorse",
        "    ```",
        "  </Tab>",
        '  <Tab value="Go">',
        "    ```bash",
        "    go get github.com/stablemates/workhorse/go",
        "    ```",
        "  </Tab>",
        "</Tabs>",
        "",
        "## Next",
      ].join("\n"),
      "quickstart",
    );

    expect(markdown).toBe(
      [
        "## Install",
        "",
        "**TypeScript**",
        "",
        "```bash",
        "npm install @stablemates/workhorse",
        "```",
        "",
        "**Python**",
        "",
        "```bash",
        "pip install stablemates-workhorse",
        "```",
        "",
        "**Go**",
        "",
        "```bash",
        "go get github.com/stablemates/workhorse/go",
        "```",
        "",
        "## Next",
      ].join("\n"),
    );
  });

  it("adds no heading, so the twin's outline still matches the page", () => {
    const source = [
      "# Only heading",
      "",
      '<Tabs items={["TypeScript"]}>',
      '  <Tab value="TypeScript">',
      "    Prose.",
      "  </Tab>",
      "</Tabs>",
    ].join("\n");

    const headings = mdxToMarkdown(source, "example")
      .split("\n")
      .filter((line) => line.startsWith("#"));
    expect(headings).toEqual(["# Only heading"]);
  });

  it("de-indents a tab body without touching indentation inside it", () => {
    const markdown = mdxToMarkdown(
      [
        '<Tabs items={["TypeScript"]}>',
        '  <Tab value="TypeScript">',
        "    ```ts",
        "    if (ready) {",
        "      run();",
        "    }",
        "    ```",
        "  </Tab>",
        "</Tabs>",
      ].join("\n"),
      "example",
    );

    expect(markdown).toContain("```ts\nif (ready) {\n  run();\n}\n```");
  });

  it("leaves prose and fenced code outside a tab exactly as it found them", () => {
    const source = ["Prose with `Array<Job>` in it.", "", "```ts", "  const x = 1;", "```"].join(
      "\n",
    );
    expect(mdxToMarkdown(source, "example")).toBe(source);
  });

  it("labels each valueless tab from its own place in the items list", () => {
    const markdown = mdxToMarkdown(
      [
        '<Tabs items={["TypeScript", "Python", "Go"]}>',
        "  <Tab>",
        "    One.",
        "  </Tab>",
        "  <Tab>",
        "    Two.",
        "  </Tab>",
        "  <Tab>",
        "    Three.",
        "  </Tab>",
        "</Tabs>",
      ].join("\n"),
      "example",
    );
    expect(markdown).toBe(
      [
        "**TypeScript**",
        "",
        "One.",
        "",
        "**Python**",
        "",
        "Two.",
        "",
        "**Go**",
        "",
        "Three.",
        // A tabs block ends with a blank line, so whatever follows it in the
        // page starts its own paragraph.
        "",
      ].join("\n"),
    );
  });

  it("throws on an MDX component it does not know, naming the component and the page", () => {
    expect(() => mdxToMarkdown("<Callout>Read this.</Callout>", "retries")).toThrow(
      /"retries".*<Callout>/s,
    );
  });

  it("throws on a component the page hides inside a tab", () => {
    const source = [
      '<Tabs items={["Go"]}>',
      '  <Tab value="Go">',
      "    <Steps>one</Steps>",
      "  </Tab>",
      "</Tabs>",
    ].join("\n");
    expect(() => mdxToMarkdown(source, "workers")).toThrow(/<Steps>/);
  });

  it("throws when a tabs block is left open", () => {
    expect(() => mdxToMarkdown('<Tabs items={["Go"]}>', "workers")).toThrow(/unclosed/);
  });
});

describe("the origin's Markdown type", () => {
  it("serves .md as text/markdown with a UTF-8 charset", async () => {
    const config = await readFile(resolve(repositoryRoot, "site/nginx.conf"), "utf8");
    expect(config).toMatch(/types\s*\{\s*text\/markdown\s+md;\s*}/);
    expect(config).toMatch(/^\s*charset\s+utf-8;$/m);
    expect(config).toMatch(/^\s*charset_types\s+[^;]*\btext\/markdown\b[^;]*;$/m);
  });
});
