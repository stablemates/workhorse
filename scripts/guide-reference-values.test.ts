import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./packages.js";

// A guide states exact values only inside its collapsed `Reference:` blocks, and each block's
// `More detail:` line links the sections that own those values. When a limit or default changes,
// the owning section changes with it. This check holds every number a block states to the sections
// its `More detail:` line links, so a block that still states the old value fails (ADR 0089).
//
// It compares presence, not meaning: the number must appear as a whole token somewhere in a linked
// section. Thousands separators are ignored on both sides, so `1,000` matches `1000` and `1_000`.

type Node = {
  type: string;
  value?: string;
  depth?: number;
  children?: Node[];
  position?: { start: { offset?: number } };
};

/** Each heading's anchor and the text from that heading to the next heading at its level or above. */
function sectionsOf(source: string): Map<string, string> {
  const tree = fromMarkdown(source) as Node;
  const slugger = new GithubSlugger();
  const headings = (tree.children ?? [])
    .filter((node) => node.type === "heading")
    .map((node) => ({
      anchor: slugger.slug(toString(node, { includeHtml: false })),
      depth: node.depth!,
      start: node.position!.start.offset!,
    }));
  const sections = new Map<string, string>();
  for (const [index, heading] of headings.entries()) {
    const next = headings.slice(index + 1).find((later) => later.depth <= heading.depth);
    sections.set(heading.anchor, source.slice(heading.start, next?.start ?? source.length));
  }
  return sections;
}

const withoutSeparators = (text: string) => text.replace(/(?<=\d)[,_](?=\d{3})/g, "");

// Inline nodes render next to their neighbors. Every other node, such as a paragraph or a list
// item, renders as a separate run of text.
const inlineContainers = new Set(["emphasis", "strong", "delete", "link", "linkReference"]);

/**
 * The text a reader sees. Parsing decodes entities and drops emphasis, link destinations, and list
 * markers, so a sign written outside a code span or emphasis stays next to its digits. A code span
 * renders its trimmed contents, because a value such as `max(100, n)` can sit inside code.
 */
function renderedText(markdown: string): string {
  const parts: string[] = [];
  // An inline tag such as `<strong>` renders nothing between its neighbors. A block of HTML, such as
  // `<summary>`, stands apart from them.
  const render = (node: Node, inline: boolean) => {
    if (node.type === "text") parts.push(node.value!);
    else if (node.type === "inlineCode" || node.type === "code") parts.push(node.value!.trim());
    else if (node.type === "html") parts.push(node.value!.replace(/<[^>]*>/g, inline ? "" : " "));
    else if (inlineContainers.has(node.type)) {
      for (const child of node.children ?? []) render(child, true);
    } else {
      parts.push(" ");
      const paragraph = node.type === "paragraph" || node.type === "heading";
      for (const child of node.children ?? []) render(child, paragraph);
      parts.push(" ");
    }
  };
  render(fromMarkdown(markdown) as Node, false);
  // U+2212, also written `&minus;`, is a minus sign. Parsing has decoded the entity by now.
  return parts.join("").replaceAll("\u2212", "-");
}

// A number starts where no word character precedes it: the digits of a name such as `SHA-256`,
// `P1007`, or `retry_v1` are not a value. Letters after a number are its unit, as in `999ms`, and
// dotted parts belong to it, as in the version `0.200.0`. A minus sign belongs to a number unless a
// word character precedes it. After a word character, as in `UTF-8` or `1-100`, the hyphen joins
// two words.
// A `v` before a dotted version, as in `v1.0.0`, is not part of the value. Exponents such as `1e9`
// and leading-dot decimals such as `.5` stay whole.
// A version keeps its prerelease label, as in `1.0.0-rc.1`. Two dots separate the ends of a range,
// as in `0..100`, so only a single dot before digits joins them to a name.
const prerelease = String.raw`(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const digits = String.raw`(?:\d+\.\d+\.\d+${prerelease}|\d+(?:\.\d+)*)`;
const number = new RegExp(
  String.raw`(?<![\w.])v(\d+(?:\.\d+)+${prerelease})|` +
    String.raw`((?:(?<!\w)-)?(?:(?<!\w|(?<!\.)\.|[A-Za-z]-)${digits}|(?<![\w.])\.\d+)(?:[eE][-+]?\d+)?)`,
  "g",
);

/** The numbers a text states, each with its sign. A guide and its owning section use the same rules. */
function numbersIn(markdown: string): Set<string> {
  const text = withoutSeparators(renderedText(markdown));
  return new Set([...text.matchAll(number)].map((match) => match[1] ?? match[2]!));
}

const statedValues = (block: string) => [...numbersIn(block)];

/** Whether a section states a value as a whole token with the same sign. */
const statesValue = (section: string, value: string) => numbersIn(section).has(value);

type ReferenceBlock = { line: number; body: string; sources: string[] };

// Blank lines and indentation around `<summary>` do not change how a block renders.
function referenceBlocks(guide: string): ReferenceBlock[] {
  const blocks = /^<details>\s*<summary>\s*Reference:[\s\S]*?^<\/details>[ \t]*$/gm;
  return [...guide.matchAll(blocks)].map((match) => {
    const moreDetail = /^More detail: ([\s\S]*?)(?:\n\n|(?![\s\S]))/m.exec(match[0]);
    return {
      line: guide.slice(0, match.index).split("\n").length,
      // The links on the `More detail:` line name sources, not values. Any other text there is checked.
      body:
        moreDetail === null
          ? match[0]
          : match[0].slice(0, moreDetail.index) +
            moreDetail[0].replace(/\[[^\]]*\]\([^)]*\)/g, " ") +
            match[0].slice(moreDetail.index + moreDetail[0].length),
      sources: [...(moreDetail?.[1]!.matchAll(/\]\(([^)]+)\)/g) ?? [])].map((link) => link[1]!),
    };
  });
}

/** One finding per reference block that names no owning section or states a value none of them has. */
function driftedReferenceBlocks(
  guides: readonly string[],
  read: (file: string) => string | undefined,
): string[] {
  const sectionsByFile = new Map<string, Map<string, string> | undefined>();
  const findings: string[] = [];
  for (const guide of guides) {
    const guideContents = read(guide) ?? "";
    const blocks = referenceBlocks(guideContents);
    const summaries = guideContents.match(/<summary>\s*Reference:/g)?.length ?? 0;
    if (summaries !== blocks.length) {
      findings.push(`${guide} has ${summaries - blocks.length} unchecked \`Reference:\` summaries`);
    }
    for (const block of blocks) {
      const at = `${guide}:${block.line}`;
      if (block.sources.length === 0) {
        findings.push(`${at} links no owning section on a \`More detail:\` line`);
        continue;
      }
      const owned: Set<string>[] = [];
      for (const source of block.sources) {
        const [target = "", anchor] = source.split("#");
        const file = path.posix.join(path.posix.dirname(guide), target);
        if (!sectionsByFile.has(file)) {
          const contents = read(file);
          sectionsByFile.set(file, contents === undefined ? undefined : sectionsOf(contents));
        }
        const section = anchor === undefined ? read(file) : sectionsByFile.get(file)?.get(anchor);
        if (section === undefined) findings.push(`${at} links missing section ${source}`);
        else owned.push(numbersIn(section));
      }
      const missing = statedValues(block.body).filter(
        (value) => !owned.some((values) => values.has(value)),
      );
      if (missing.length > 0 && owned.length === block.sources.length) {
        findings.push(
          `${at} states ${missing.join(", ")}, absent from ${block.sources.join(" and ")}`,
        );
      }
    }
  }
  return findings;
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

const block = (...lines: string[]) =>
  ["<details>", "<summary>Reference: limits</summary>", "", ...lines, "", "</details>"].join("\n");

describe("guide reference values", () => {
  it("collects the numbers a block states and skips names, links, and list markers", () => {
    expect(
      statedValues(
        [
          "1. `max_attempts` is 1 to 100, and `retry_v1` waits 1,000 ms.",
          "2. A UTF-8 key of 512 bytes is hashed with SHA-256. See [retries](110-retries.md).",
          "3. The window is `86400000` ms, or 0.5 days.",
        ].join("\n"),
      ),
    ).toEqual(["1", "100", "1000", "512", "86400000", "0.5"]);
  });

  it("keeps the sign of a negative number and not the hyphen of a range", () => {
    expect(statedValues("Priority is -100 to 100, `-5`, or \u22122, and 1-10 is a range.")).toEqual(
      ["-100", "100", "-5", "-2", "1", "10"],
    );
    expect(statesValue("Priority is 0 to 100.", "-100")).toBe(false);
    expect(statesValue("Priority is -100 to 0.", "100")).toBe(false);
    expect(statesValue("Priority is `-100` to 0.", "-100")).toBe(true);
    expect(statesValue("Ranges such as 1-100.", "100")).toBe(true);
    expect(statedValues('Priority is "-100" through 100, or -1 in the name x-2.')).toEqual([
      "-100",
      "100",
      "-1",
    ]);
    expect(statesValue('Priority is "-100" through 100.', "-100")).toBe(true);
    expect(statedValues("Priority is -`100` through `100`.")).toEqual(["-100", "100"]);
    expect(statesValue("Priority is -`100` through 100.", "-100")).toBe(true);
    expect(statedValues("Wait 999ms, use `>=0.200.0 <1.2`, not `P1007` or x86_64.")).toEqual([
      "999",
      "0.200.0",
      "1.2",
    ]);
    expect(statedValues("In `0..999`, from `v1.0.0-rc.9` to 2.0.0-beta.1.")).toEqual([
      "0",
      "999",
      "1.0.0-rc.9",
      "2.0.0-beta.1",
    ]);
    expect(statedValues("Removed in v1.1.0, not dev2.0. Rates of 1e9 or .5 per -.5 ms.")).toEqual([
      "1.1.0",
      "1e9",
      ".5",
      "-.5",
    ]);
    expect(statedValues("`max(999, floor(leaseMs / 7))` or `999 ms` or &minus;5.")).toEqual([
      "999",
      "7",
      "-5",
    ]);
    expect(
      statedValues("From -**`100`** to ` 999 `, `\u2212999`, or -<strong>5</strong>."),
    ).toEqual(["-100", "999", "-999", "-5"]);
    expect(statesValue("Priority is 0 through `100`.", "-100")).toBe(false);
  });

  it("matches a value as a whole token whatever its thousands separators", () => {
    expect(statesValue("At most 1,000 rows.", "1000")).toBe(true);
    expect(statesValue("At most `1_000` rows.", "1000")).toBe(true);
    expect(statesValue("At most 10000 rows.", "1000")).toBe(false);
    expect(statesValue("Version 1.0.", "1")).toBe(false);
    expect(statesValue("Uses `limit_v1`.", "1")).toBe(false);
    expect(statesValue("Keys are stored as SHA-256 hashes.", "256")).toBe(false);
    expect(statesValue("See [keys](keys-256.md).", "256")).toBe(false);
    expect(statesValue("The renewal waits `max(100, n)` ms.", "100")).toBe(true);
    expect(statesValue("1. A reason holds 1 through\n2,000.", "2000")).toBe(true);
    expect(statesValue("1. A reason holds 1 through\n2,000.", "1")).toBe(true);
    expect(statesValue("1. First step.\n2. Second step.", "2")).toBe(false);
  });

  it("reports a value that the linked section does not state", () => {
    const files = {
      "docs/guides/110-retries.md": [
        "# What happens when a task fails?",
        "",
        block(
          "`max_attempts` is 1 to 100.",
          "",
          "More detail: [Retry](../architecture/lifecycle.md#retry).",
        ),
        "",
        block(
          "The default is 25 attempts.",
          "",
          "More detail: [Retry](../architecture/lifecycle.md#retry).",
        ),
      ].join("\n"),
      "docs/architecture/lifecycle.md": [
        "# Lifecycle",
        "## Retry",
        "`max_attempts` is 1 to 50.",
        "### Defaults",
        "The default is 25 attempts.",
        "## Claim",
        "A claim inspects 100 rows.",
      ].join("\n"),
    };
    expect(driftedReferenceBlocks(["docs/guides/110-retries.md"], readFixture(files))).toEqual([
      "docs/guides/110-retries.md:3 states 100, absent from ../architecture/lifecycle.md#retry",
    ]);
  });

  it("accepts a value that any of several linked sections states, across a wrapped line", () => {
    const files = {
      "docs/guides/250-rate-limits.md": block(
        "A key is 1 to 256 bytes. A claim inspects 100 rows.",
        "",
        "More detail: [Keys](../architecture/data-model.md#keys) and",
        "[Claim](../architecture/lifecycle.md#claim).",
      ),
      "docs/architecture/data-model.md": "## Keys\nA key is 1 to 256 bytes.",
      "docs/architecture/lifecycle.md": "## Claim\nA claim inspects 100 rows.",
    };
    expect(driftedReferenceBlocks(["docs/guides/250-rate-limits.md"], readFixture(files))).toEqual(
      [],
    );
  });

  it("reports a block without an owning section and a link to a missing section", () => {
    const files = {
      "docs/guides/150-priority.md": [
        block("Priority is 0 to 100."),
        block(
          "Priority is 0 to 100.",
          "",
          "More detail: [Gone](../architecture/data-model.md#gone).",
        ),
      ].join("\n"),
      "docs/architecture/data-model.md": "## Priority\nPriority is 0 to 100.",
    };
    expect(driftedReferenceBlocks(["docs/guides/150-priority.md"], readFixture(files))).toEqual([
      "docs/guides/150-priority.md:1 links no owning section on a `More detail:` line",
      "docs/guides/150-priority.md:7 links missing section ../architecture/data-model.md#gone",
    ]);
  });

  it("checks a block whose summary follows a blank line", () => {
    const files = {
      "docs/guides/150-priority.md": [
        "<details>",
        "",
        "  <summary>Reference: priority</summary>",
        "",
        "Priority is 0 to 999.",
        "",
        "More detail: [Priority](../architecture/data-model.md#priority).",
        "",
        "</details>",
        "",
        "<details><summary>Reference: unclosed</summary>",
      ].join("\n"),
      "docs/architecture/data-model.md": "## Priority\nPriority is 0 to 100.",
    };
    expect(driftedReferenceBlocks(["docs/guides/150-priority.md"], readFixture(files))).toEqual([
      "docs/guides/150-priority.md has 1 unchecked `Reference:` summaries",
      "docs/guides/150-priority.md:1 states 999, absent from ../architecture/data-model.md#priority",
    ]);
  });

  it("reads values through emphasis and after the More detail line", () => {
    expect(
      statedValues("Priority is -**100** or **-50** to _100_, and `max_v1` is ~~7~~."),
    ).toEqual(["-100", "-50", "100", "7"]);
    const files = {
      "docs/guides/150-priority.md": block(
        "Priority is 0 to 100.",
        "",
        "More detail: [Priority](../architecture/data-model.md#priority). The minimum is 9.",
        "The default is 999.",
        "",
        "Version 1 has 99 values.",
      ),
      "docs/architecture/data-model.md": "## Priority\nPriority is 0 to 100. The default is 0.",
    };
    expect(driftedReferenceBlocks(["docs/guides/150-priority.md"], readFixture(files))).toEqual([
      "docs/guides/150-priority.md:1 states 9, 999, 1, 99, absent from ../architecture/data-model.md#priority",
    ]);
  });

  it("finds every guide value in the sections its reference block links", () => {
    const guides = readdirSync(path.join(repositoryRoot, "docs/guides"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => `docs/guides/${file}`);
    expect(driftedReferenceBlocks(guides, readRepositoryFile)).toEqual([]);
  });
});
