import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { toString } from "mdast-util-to-string";
import { mdxjs } from "micromark-extension-mdxjs";
import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./packages.js";

// A link to `page.md#heading` that names no heading lands the reader at the top of the page. These
// checks resolve every in-repository anchor: relative Markdown links, links to this repository on
// GitHub, and site links under `/docs/`. Each file is parsed into a syntax tree, so fenced code is
// neither a heading nor a link, a destination may wrap across lines, and a heading's anchor comes
// from its rendered text. A reference-style link is checked at its definition, which every use of
// the label shares.

const githubBlob = "https://github.com/stablemates/workhorse/blob/main/";

type Node = {
  type: string;
  url?: string;
  value?: string;
  name?: string | null;
  attributes?: { type: string; name?: string; value?: unknown }[];
  children?: Node[];
  position?: { start: { line: number } };
};

// Front matter is not Markdown. Blanking it keeps the line numbers of everything after it.
function parse(file: string, source: string): Node {
  const frontMatter = /^---\n[\s\S]*?\n---(?=\n|$)/.exec(source)?.[0];
  const body =
    frontMatter === undefined
      ? source
      : frontMatter.replace(/[^\n]/g, "") + source.slice(frontMatter.length);
  return (
    file.endsWith(".mdx")
      ? fromMarkdown(body, { extensions: [mdxjs()], mdastExtensions: [mdxFromMarkdown()] })
      : fromMarkdown(body)
  ) as Node;
}

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

// GitHub and the site both slug a heading's rendered text with `github-slugger`, which also gives
// a repeated slug the next free `-1`, `-2`, and so on.
function headingAnchors(file: string, source: string): Set<string> {
  const anchors = new Set<string>();
  const slugger = new GithubSlugger();
  for (const node of walk(parse(file, source))) {
    if (node.type === "heading") anchors.add(slugger.slug(toString(node, { includeHtml: false })));
    if (node.type === "html") {
      for (const explicit of node.value!.matchAll(/<a\s+(?:id|name)="([^"]+)"/g))
        anchors.add(explicit[1]!);
    }
    if (node.type.startsWith("mdxJsx") && node.name === "a") {
      for (const attribute of node.attributes ?? []) {
        if (
          (attribute.name === "id" || attribute.name === "name") &&
          typeof attribute.value === "string"
        ) {
          anchors.add(attribute.value);
        }
      }
    }
  }
  return anchors;
}

function linkTarget(from: string, href: string): { file: string; anchor: string } | undefined {
  const hash = href.indexOf("#");
  if (hash === -1) return undefined;
  // A query string selects a view of the file, such as GitHub's `?plain=1`, not another file.
  const target = href.slice(0, hash).replace(/\?.*$/, "");
  const anchor = decodeURIComponent(href.slice(hash + 1));
  let file: string;
  if (target.startsWith(githubBlob)) file = target.slice(githubBlob.length);
  // A site page `/docs/page` also serves its Markdown twin at `/docs/page.md`.
  else if (href.startsWith("/docs/")) file = `site/content${target.replace(/\.md$/, "")}.mdx`;
  else if (href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  else file = target === "" ? from : path.posix.join(path.posix.dirname(from), target);
  return /\.mdx?$/.test(file) ? { file, anchor } : undefined;
}

function brokenAnchors(files: readonly string[], read: (file: string) => string | undefined) {
  const anchorsByFile = new Map<string, Set<string> | undefined>();
  const broken: string[] = [];
  for (const from of files) {
    for (const node of walk(parse(from, read(from) ?? ""))) {
      if (node.type !== "link" && node.type !== "definition") continue;
      const target = linkTarget(from, node.url!);
      if (target === undefined) continue;
      if (!anchorsByFile.has(target.file)) {
        const source = read(target.file);
        anchorsByFile.set(
          target.file,
          source === undefined ? undefined : headingAnchors(target.file, source),
        );
      }
      if (anchorsByFile.get(target.file)?.has(target.anchor) !== true) {
        broken.push(`${from}:${node.position!.start.line} links ${target.file}#${target.anchor}`);
      }
    }
  }
  return broken;
}

function readRepositoryFile(file: string): string | undefined {
  try {
    return readFileSync(path.join(repositoryRoot, file), "utf8");
  } catch {
    return undefined;
  }
}

function readFixture(files: Record<string, string>) {
  return (file: string) => files[file];
}

describe("Markdown anchors", () => {
  it("slugs headings the way GitHub renders them", () => {
    expect([
      ...headingAnchors(
        "docs/guide.md",
        [
          "# Can I run `Worker.start()` twice?",
          "## PostgreSQL connection poolers",
          "## Retry [policy](x.md)",
          "## Retry policy",
          "# Hello",
          "# Hello-1",
          "# Hello",
          '<a id="custom"></a>',
        ].join("\n"),
      ),
    ]).toEqual([
      "can-i-run-workerstart-twice",
      "postgresql-connection-poolers",
      "retry-policy",
      "retry-policy-1",
      "hello",
      "hello-1",
      "hello-2",
      "custom",
    ]);
  });

  it("reports a link to a heading that does not exist", () => {
    const files = {
      "docs/kubernetes.md": "See [poolers](compatibility.md#connection-poolers).",
      "docs/compatibility.md": "## PostgreSQL connection poolers",
      "site/content/docs/contracts.mdx": `[reference](${githubBlob}docs/architecture.md#job)`,
      "docs/architecture.md": "### `task`",
    };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "docs/kubernetes.md:1 links docs/compatibility.md#connection-poolers",
      "site/content/docs/contracts.mdx:1 links docs/architecture.md#job",
    ]);
  });

  it("reports a reference-style link to a heading that does not exist", () => {
    const files = {
      "docs/kubernetes.md": [
        "See [poolers][reference] and [the same][reference].",
        "",
        '[reference]: compatibility.md#connection-poolers "Poolers"',
        "[valid]: <compatibility.md#postgresql-connection-poolers>",
      ].join("\n"),
      "docs/compatibility.md": "## PostgreSQL connection poolers",
    };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "docs/kubernetes.md:3 links docs/compatibility.md#connection-poolers",
    ]);
  });

  it("reports a link with a quoted or parenthesized title to a heading that does not exist", () => {
    const files = {
      "docs/kubernetes.md": [
        '[double](compatibility.md#gone-double "Title")',
        "[single](compatibility.md#gone-single 'Title')",
        "[parenthesized](compatibility.md#gone-parenthesized (Title))",
        "[valid](compatibility.md#postgresql-connection-poolers 'Title')",
      ].join("\n"),
      "docs/compatibility.md": "## PostgreSQL connection poolers",
    };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "docs/kubernetes.md:1 links docs/compatibility.md#gone-double",
      "docs/kubernetes.md:2 links docs/compatibility.md#gone-single",
      "docs/kubernetes.md:3 links docs/compatibility.md#gone-parenthesized",
    ]);
  });

  it("resolves a site link to a page or its Markdown twin", () => {
    const files = {
      "site/content/docs/workers.mdx": [
        "[page](/docs/enqueue#transactions)",
        "[twin](/docs/enqueue.md#transactions)",
        "[gone](/docs/enqueue.md#gone)",
      ].join("\n"),
      "site/content/docs/enqueue.mdx": "## Transactions",
    };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "site/content/docs/workers.mdx:3 links site/content/docs/enqueue.mdx#gone",
    ]);
  });

  it("reports a link whose destination wraps across lines", () => {
    const files = {
      "docs/kubernetes.md": [
        "See [poolers](",
        "compatibility.md#connection-poolers",
        ") and [the reference",
        "page](compatibility.md#postgresql-connection-poolers).",
      ].join("\n"),
      "docs/compatibility.md": "## PostgreSQL connection poolers",
    };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "docs/kubernetes.md:1 links docs/compatibility.md#connection-poolers",
    ]);
  });

  it("slugs a heading from its rendered text, not its emphasis markup", () => {
    const files = {
      "docs/workers.md": [
        "## Run _worker_ **now**",
        "[valid](#run-worker-now)",
        "[markup](#run-_worker_-now)",
      ].join("\n"),
    };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "docs/workers.md:3 links docs/workers.md#run-_worker_-now",
    ]);
  });

  it("slugs a heading from its rendered text, not its inline HTML", () => {
    const files = {
      "docs/workers.md": [
        "## Run <em>worker</em> now",
        "[valid](#run-worker-now)",
        "[markup](#run-emworkerem-now)",
      ].join("\n"),
    };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "docs/workers.md:3 links docs/workers.md#run-emworkerem-now",
    ]);
  });

  it("checks the anchor of a link that carries a query string", () => {
    const files = {
      "docs/kubernetes.md": [
        "[relative](compatibility.md?ref=docs#connection-poolers)",
        `[github](${githubBlob}docs/compatibility.md?plain=1#connection-poolers)`,
        "[valid](compatibility.md?ref=docs#postgresql-connection-poolers)",
        `[valid github](${githubBlob}docs/compatibility.md?plain=1#postgresql-connection-poolers)`,
      ].join("\n"),
      "docs/compatibility.md": "## PostgreSQL connection poolers",
    };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "docs/kubernetes.md:1 links docs/compatibility.md#connection-poolers",
      "docs/kubernetes.md:2 links docs/compatibility.md#connection-poolers",
    ]);
  });

  it("reports an anchor into a file that does not exist", () => {
    const files = { "docs/a.md": "[gone](guides/gone.md#section)" };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "docs/a.md:1 links docs/guides/gone.md#section",
    ]);
  });

  it("ignores headings and links inside fenced prototypes", () => {
    const files = {
      "docs/decisions/0001-x.md": [
        "````markdown",
        "# Prototype",
        "```ts",
        "code();",
        "```",
        "[old](../architecture.md#removed-heading)",
        "````",
        "[current](#decision)",
        "## Decision",
        "[prototype heading](#prototype)",
      ].join("\n"),
    };
    expect(brokenAnchors(Object.keys(files), readFixture(files))).toEqual([
      "docs/decisions/0001-x.md:10 links docs/decisions/0001-x.md#prototype",
    ]);
  });

  it("resolves every anchor in the repository's Markdown", () => {
    const files = execFileSync("git", ["ls-files", "*.md", "*.mdx"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter((file) => file !== "");
    expect(brokenAnchors(files, readRepositoryFile)).toEqual([]);
  });
});
