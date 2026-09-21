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
    const source = ["Prose with `Array<Task>` in it.", "", "```ts", "  const x = 1;", "```"].join(
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

describe("the origin's negotiation and Markdown type", () => {
  const config = () => readFile(resolve(repositoryRoot, "site/nginx.conf"), "utf8");

  it("serves .md as text/markdown with a UTF-8 charset", async () => {
    const source = await config();
    expect(source).toMatch(/types\s*\{\s*text\/markdown\s+md;\s*}/);
    expect(source).toMatch(/^\s*charset\s+utf-8;$/m);
    expect(source).toMatch(/^\s*charset_types\s+[^;]*\btext\/markdown\b[^;]*;$/m);
  });

  it("labels the JSON 404 body with the same charset", async () => {
    expect(await config()).toMatch(/^\s*charset_types\s+[^;]*\bapplication\/json\b[^;]*;$/m);
  });

  // A map stops at its first matching regex, so a rejection that followed the
  // acceptance would never fire and `text/markdown;q=0` would get the twin.
  it("reads Accept once and lists the q=0 rejection before the acceptance", async () => {
    const source = await config();
    expect(source).toMatch(/^map \$http_accept \$want \{$/m);
    const rejection = source.indexOf('"~*text/markdown\\s*;\\s*q=0(\\.0+)?\\s*(,|$)" html;');
    const acceptance = source.indexOf('"~*text/markdown" markdown;');
    expect(rejection).toBeGreaterThan(-1);
    expect(acceptance).toBeGreaterThan(rejection);
  });

  // `Vary: Accept` is what keeps a cache from handing a browser the twin. The
  // `always` is what keeps it on a 404, and the 404 body follows the same
  // negotiation instead of being one HTML page for every client.
  it("varies every negotiated response by Accept, errors included", async () => {
    const source = await config();
    const catchAll = /^  location \/ \{([^}]*)\}/m.exec(source)?.[1];
    expect(catchAll).toContain("add_header Vary Accept always;");
    expect(source).toMatch(/^\s*error_page 404 \$not_found_body;$/m);
  });

  // The 404 bodies are files in the web root. Without `internal`, a crawler
  // that reaches /404.md gets a 200 page to index, and /not-found is the same
  // page under the URL the prerenderer emits.
  it("keeps the 404 bodies and both not-found URLs internal", async () => {
    const source = await config();
    const internalBlock = [...source.matchAll(/^  location ~ ([^{]+)\{([^}]*)\}/gm)].find((block) =>
      block[2]!.includes("internal;"),
    );
    expect(internalBlock).toBeDefined();
    // The pattern is nginx's, so it is asserted by what it matches rather than
    // by its text: a rewrite that still reads correctly can stop covering a URL.
    const pattern = new RegExp(internalBlock![1]!.trim());
    for (const uri of ["/404.md", "/404.json", "/not-found", "/not-found/index.html"]) {
      expect(pattern.test(uri), `${uri} should be internal`).toBe(true);
    }
    for (const uri of ["/", "/docs/quickstart", "/docs/quickstart.md"]) {
      expect(pattern.test(uri), `${uri} should not be internal`).toBe(false);
    }
  });

  // A twin restates a page a search engine already has. noindex settles that
  // without a Disallow, so the agent the twin exists for still reads it.
  // `typescript/core/test/site-nginx-smoke.ts` proves the served header, but it
  // needs an nginx the CI image does not carry, so the rule is asserted here.
  it("answers a twin and the agent indexes with noindex, and a page without", async () => {
    const source = await config();
    const block = [...source.matchAll(/^  location ~ ([^{]+)\{([^}]*)\}/gm)].find((entry) =>
      entry[2]!.includes("X-Robots-Tag"),
    );
    expect(block).toBeDefined();
    expect(block![2]).toContain("add_header X-Robots-Tag noindex always;");
    const pattern = new RegExp(block![1]!.trim());
    for (const uri of ["/docs/quickstart.md", "/docs.md", "/about.md", "/llms.txt"]) {
      expect(pattern.test(uri), `${uri} should answer noindex`).toBe(true);
    }
    // The canonical page must not, or the twin's noindex would deindex the page
    // it stands for. Nor may the sitemap, which a crawler is meant to read.
    for (const uri of ["/docs/quickstart", "/", "/sitemap.xml", "/robots.txt"]) {
      expect(pattern.test(uri), `${uri} should not answer noindex`).toBe(false);
    }
  });

  // One page, one URL. try_files accepts a path with or without a trailing
  // slash, so the redirect is what keeps the second URL from answering 200.
  it("redirects a trailing slash to the canonical path, and exempts the root", async () => {
    const source = await config();
    const block = /^  location ~ ([^{]+)\{\s*return 301 \$1\$is_args\$args;\s*\}/m.exec(source);
    expect(block).toBeDefined();
    const pattern = new RegExp(block![1]!.trim());
    expect(pattern.test("/docs/quickstart/")).toBe(true);
    expect(pattern.test("/docs/")).toBe(true);
    expect(pattern.test("/"), "the root's trailing slash is its canonical form").toBe(false);
    expect(pattern.test("/docs/quickstart")).toBe(false);
  });

  // nginx would otherwise rebuild each Location from the Host and the scheme
  // the origin was served over, which is plain HTTP behind the edge. A reader
  // on HTTPS would be sent to the http:// URL and bounced back.
  it("sends every redirect as a path rather than an absolute URL", async () => {
    expect(await config()).toMatch(/^\s*absolute_redirect off;$/m);
  });

  it("answers a Markdown-only client with 406 when a page has no twin", async () => {
    expect(await config()).toMatch(/^  location @unavailable \{[\s\S]*?return 406 /m);
  });
});
