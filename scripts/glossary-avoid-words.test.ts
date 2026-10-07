import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./packages.js";

// `CONTEXT.md` is the project vocabulary. Each glossary term may list words to avoid, such as
// "job" for a task or "mode" for a tier. This check flags those words in the Markdown under
// `docs/`, so a page cannot drift back to a retired term.
//
// Code spans and fenced code hold identifiers, so the check never reads a word inside them. Many
// avoided words also have an unrelated English sense: a migration step, a pool mode, an error
// message. `glossary-allowlist.json` names each such sense as a context pattern around one word.
// A context that could match the bare word is rejected, and an entry that matches nothing fails
// as stale, so the list shrinks as the text changes.

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { line: number } };
};

type Term = { term: string; avoid: string[] };

type HistoricalPath = { files: string; reason: string };
type ContextEntry = { word: string; files: string; context: string; reason: string };
type Allowlist = { historicalPaths: HistoricalPath[]; contexts: ContextEntry[] };

// Only records of past decisions and past measurements keep the wording of their time.
const historicalRoots = ["docs/decisions/**", "docs/benchmarks/**"];

/** Each glossary term that lists words to avoid, with those words. */
function glossaryTerms(context: string): Term[] {
  const terms: Term[] = [];
  for (const entry of context.split(/\n\s*\n/)) {
    const term = /^\*\*(.+?)\*\*:/.exec(entry.trim())?.[1];
    const avoid = /^_Avoid[^_]*_: ([\s\S]+)$/m.exec(entry)?.[1];
    if (term === undefined || avoid === undefined) continue;
    terms.push({
      term,
      avoid: avoid
        .replace(/\s+/g, " ")
        .split(",")
        .map((word) => word.trim())
        .filter((word) => word !== ""),
    });
  }
  return terms;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-word, case-insensitive pattern for a word or phrase and its plural. */
function wordPattern(word: string): RegExp {
  const words = word.split(/[\s-]+/).map(escape);
  const last = words.pop()!;
  const plural = last.endsWith("y") ? `(?:${last}|${last.slice(0, -1)}ies)` : `${last}(?:e?s)?`;
  return new RegExp(String.raw`\b${[...words, plural].join(String.raw`[\s-]+`)}\b`, "gi");
}

type Segment = { text: string; code: boolean; line: number };

// A block's text is read as one run, so a context can span emphasis, links, and code spans.
const blockTypes = new Set(["paragraph", "heading", "tableCell"]);

const htmlCodeTag = /(<\/?(?:code|pre)\b[^>]*>)/i;

/** The readable text of each block, split into prose and code segments with their start lines. */
function blocksOf(source: string): Segment[][] {
  const blocks: Segment[][] = [];
  // Text between HTML `<code>` or `<pre>` tags is code, as a code span is. An inline tag arrives as
  // its own node, so the state carries across the nodes of one block.
  let inCode = false;
  const flatten = (node: Node, into: Segment[]) => {
    const line = node.position?.start.line ?? 0;
    if (node.type === "text") into.push({ text: node.value!, code: inCode, line });
    else if (node.type === "inlineCode") into.push({ text: node.value!, code: true, line });
    else if (node.type === "html") {
      let consumed = 0;
      for (const part of node.value!.split(htmlCodeTag)) {
        if (/^<(?:code|pre)\b/i.test(part)) inCode = true;
        else if (/^<\/(?:code|pre)\b/i.test(part)) inCode = false;
        else
          into.push({ text: part.replace(/<[^>]*>/g, " "), code: inCode, line: line + consumed });
        consumed += part.split("\n").length - 1;
      }
    } else for (const child of node.children ?? []) flatten(child, into);
  };
  const visit = (node: Node) => {
    if (node.type === "code") return;
    if (blockTypes.has(node.type) || node.type === "html") {
      const segments: Segment[] = [];
      inCode = false;
      flatten(node, segments);
      blocks.push(segments);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(source) as Node);
  return blocks;
}

const maxContextLength = 60;

type Occurrence = { file: string; line: number; word: string; terms: string[]; used?: number };

/** Every avoided word in a file outside code, with the entry that allows it, if any. */
function occurrencesIn(
  file: string,
  source: string,
  terms: readonly Term[],
  contexts: readonly ContextEntry[],
): Occurrence[] {
  // Two terms can avoid the same word, such as "activity" for a task and for a handler.
  const words = new Map<string, { word: string; owners: string[] }>();
  for (const { term, avoid } of terms) {
    for (const word of avoid) {
      const key = word.toLowerCase();
      words.set(key, {
        word: words.get(key)?.word ?? word,
        owners: [...(words.get(key)?.owners ?? []), term],
      });
    }
  }
  const applicable = contexts
    .map((entry, index) => ({ entry, index, pattern: new RegExp(entry.context, "g") }))
    .filter(({ entry }) => path.posix.matchesGlob(file, entry.files));
  const found: Occurrence[] = [];
  for (const segments of blocksOf(source)) {
    // A context reads the block with each run of whitespace as one space, so it can span a line
    // break. `flatIndex` maps each offset in the block to its offset in that flattened text.
    const text = segments.map((segment) => segment.text).join("");
    const flatIndex: number[] = [];
    let flat = "";
    // Offsets count UTF-16 code units, as regular expression match indexes do.
    for (let index = 0; index < text.length; index++) {
      const space = /\s/.test(text[index]!);
      if (!space || !/\s/.test(text[index - 1] ?? "")) flat += space ? " " : text[index];
      flatIndex.push(flat.length - 1);
    }
    // A context longer than `maxContextLength` is ignored, so a pattern cannot reach across a
    // paragraph from a legitimate phrase to an unrelated use of the word.
    const contextMatches = applicable.map(({ entry, index, pattern }) => ({
      entry,
      index,
      spans: [...flat.matchAll(pattern)]
        .filter((match) => match[0].length <= maxContextLength)
        .map((match) => [match.index, match.index + match[0].length]),
    }));
    let offset = 0;
    for (const segment of segments) {
      if (!segment.code) {
        for (const { word, owners } of words.values()) {
          for (const match of segment.text.matchAll(wordPattern(word))) {
            const start = flatIndex[offset + match.index]!;
            const end = flatIndex[offset + match.index + match[0].length - 1]! + 1;
            const allowed = contextMatches.find(
              ({ entry, spans }) =>
                entry.word.toLowerCase() === word.toLowerCase() &&
                spans.some(([from, to]) => from! <= start && end <= to!),
            );
            found.push({
              file,
              line: segment.line + segment.text.slice(0, match.index).split("\n").length - 1,
              word,
              terms: owners,
              used: allowed?.index,
            });
          }
        }
      }
      offset += segment.text.length;
    }
  }
  return found;
}

/** Why an allowlist entry is malformed, if it is. */
function invalidEntries(allowlist: Allowlist, terms: readonly Term[]): string[] {
  const avoided = new Set(terms.flatMap(({ avoid }) => avoid.map((word) => word.toLowerCase())));
  const problems: string[] = [];
  for (const entry of allowlist.historicalPaths) {
    if (!historicalRoots.includes(entry.files)) {
      problems.push(`historical path ${entry.files} is not one of ${historicalRoots.join(", ")}`);
    }
    if (entry.reason.trim() === "") problems.push(`historical path ${entry.files} gives no reason`);
  }
  for (const entry of allowlist.contexts) {
    const name = `context "${entry.context}" for "${entry.word}" in ${entry.files}`;
    if (!avoided.has(entry.word.toLowerCase())) {
      problems.push(`${name} names a word no CONTEXT.md term avoids`);
    }
    if (entry.reason.trim() === "") problems.push(`${name} gives no reason`);
    if (!entry.files.startsWith("docs/")) problems.push(`${name} matches files outside docs/`);
    // Contexts are case-sensitive, so "Kubernetes Job" never allows "job". The bare-word test
    // ignores case, so a context cannot pass by capitalizing the word alone.
    const pattern = new RegExp(entry.context, "i");
    const bare = [entry.word, `${entry.word}s`, `${entry.word}es`];
    if (bare.some((word) => pattern.test(word))) {
      problems.push(`${name} matches the bare word, so it cannot tell a sense apart`);
    }
  }
  return problems;
}

/** One finding per avoided word no entry allows, and one per entry that allows nothing. */
function glossaryFindings(
  files: readonly string[],
  read: (file: string) => string,
  context: string,
  allowlist: Allowlist,
): string[] {
  const terms = glossaryTerms(context);
  const findings = invalidEntries(allowlist, terms);
  const usedHistorical = new Set<string>();
  const usedContexts = new Set<number>();
  for (const file of files) {
    const historical = allowlist.historicalPaths.find(
      (entry) => historicalRoots.includes(entry.files) && path.posix.matchesGlob(file, entry.files),
    );
    for (const occurrence of occurrencesIn(file, read(file), terms, allowlist.contexts)) {
      if (historical !== undefined) usedHistorical.add(historical.files);
      else if (occurrence.used !== undefined) usedContexts.add(occurrence.used);
      else {
        findings.push(
          `${occurrence.file}:${occurrence.line} uses "${occurrence.word}"; ` +
            `CONTEXT.md avoids it for ${occurrence.terms.map((term) => `**${term}**`).join(" and ")}`,
        );
      }
    }
  }
  for (const entry of allowlist.historicalPaths) {
    if (historicalRoots.includes(entry.files) && !usedHistorical.has(entry.files))
      findings.push(`stale historical path ${entry.files}`);
  }
  for (const [index, entry] of allowlist.contexts.entries()) {
    if (!usedContexts.has(index)) {
      findings.push(`stale context "${entry.context}" for "${entry.word}" in ${entry.files}`);
    }
  }
  return findings;
}

const readRepositoryFile = (file: string) => readFileSync(path.join(repositoryRoot, file), "utf8");

const glossary = [
  "**Task**:",
  "The unit of work.",
  "_Avoid_: Job, work",
  "item",
  "",
  "**Tier**:",
  "The per-queue setting.",
  "_Avoid as a label_: Mode, activity",
].join("\n");

const allow = (contexts: ContextEntry[], historicalPaths: HistoricalPath[] = []): Allowlist => ({
  historicalPaths,
  contexts,
});

describe("glossary avoid words", () => {
  it("reads each term's avoid list across wrapped lines", () => {
    expect(glossaryTerms(glossary)).toEqual([
      { term: "Task", avoid: ["Job", "work item"] },
      { term: "Tier", avoid: ["Mode", "activity"] },
    ]);
  });

  it("flags whole words and plurals in prose and skips code", () => {
    const page = [
      "# Jobs",
      "",
      "A job runs. Two work-items wait. `job_id` and jobless stay.",
      "",
      "```",
      "job",
      "```",
      "",
      "| Mode | Activities |",
      "| ---- | ---------- |",
    ].join("\n");
    expect(glossaryFindings(["docs/a.md"], () => page, glossary, allow([]))).toEqual([
      'docs/a.md:1 uses "Job"; CONTEXT.md avoids it for **Task**',
      'docs/a.md:3 uses "Job"; CONTEXT.md avoids it for **Task**',
      'docs/a.md:3 uses "work item"; CONTEXT.md avoids it for **Task**',
      'docs/a.md:9 uses "Mode"; CONTEXT.md avoids it for **Tier**',
      'docs/a.md:9 uses "activity"; CONTEXT.md avoids it for **Tier**',
    ]);
  });

  it("allows a word only inside its case-sensitive context, across lines, emphasis, and code", () => {
    const page =
      "The **Active**\n  Job adapter runs a job.\n\nPgBouncer `transaction` mode is a mode. Active job.";
    const contexts = [
      { word: "job", files: "docs/*.md", context: "Active Job adapter", reason: "Ruby name" },
      { word: "mode", files: "docs/*.md", context: "transaction mode", reason: "pool mode" },
    ];
    expect(glossaryFindings(["docs/a.md"], () => page, glossary, allow(contexts))).toEqual([
      'docs/a.md:2 uses "Job"; CONTEXT.md avoids it for **Task**',
      'docs/a.md:4 uses "Job"; CONTEXT.md avoids it for **Task**',
      'docs/a.md:4 uses "Mode"; CONTEXT.md avoids it for **Tier**',
    ]);
  });

  it("ignores a context match longer than the bound and skips HTML code", () => {
    const page = [
      "The Active Job adapter is described at length in this sentence, and then a job runs.",
      "",
      "<p>See <code>job</code> and <pre>a job</pre> but a job here.</p>",
    ].join("\n");
    const contexts = [
      { word: "job", files: "docs/*.md", context: "Active Job[\\s\\S]*job", reason: "too long" },
    ];
    expect(glossaryFindings(["docs/a.md"], () => page, glossary, allow(contexts))).toEqual([
      'docs/a.md:1 uses "Job"; CONTEXT.md avoids it for **Task**',
      'docs/a.md:1 uses "Job"; CONTEXT.md avoids it for **Task**',
      'docs/a.md:3 uses "Job"; CONTEXT.md avoids it for **Task**',
      'stale context "Active Job[\\s\\S]*job" for "job" in docs/*.md',
    ]);
  });

  it("applies an entry only to its word and its files", () => {
    const contexts = [{ word: "mode", files: "docs/b.md", context: "Active Job", reason: "x" }];
    expect(glossaryFindings(["docs/a.md"], () => "Active Job.", glossary, allow(contexts))).toEqual(
      [
        'docs/a.md:1 uses "Job"; CONTEXT.md avoids it for **Task**',
        'stale context "Active Job" for "mode" in docs/b.md',
      ],
    );
  });

  it("rejects an entry that matches the bare word, a foreign word, or no reason", () => {
    const contexts = [
      { word: "job", files: "docs/*.md", context: "\\w*jobs?", reason: "too broad" },
      { word: "task", files: "docs/*.md", context: "a task", reason: "" },
      { word: "mode", files: "site/*.md", context: "pool mode", reason: "pool" },
    ];
    expect(
      glossaryFindings([], () => "", glossary, allow(contexts)).filter(
        (finding) => !finding.startsWith("stale"),
      ),
    ).toEqual([
      'context "\\w*jobs?" for "job" in docs/*.md matches the bare word, so it cannot tell a sense apart',
      'context "a task" for "task" in docs/*.md names a word no CONTEXT.md term avoids',
      'context "a task" for "task" in docs/*.md gives no reason',
      'context "pool mode" for "mode" in site/*.md matches files outside docs/',
    ]);
  });

  it("keeps whole-path entries to historical records and reports them stale", () => {
    const historical = [
      { files: "docs/decisions/**", reason: "Decision records keep their original wording." },
      { files: "docs/guides/**", reason: "Not historical." },
      { files: "docs/benchmarks/**", reason: "Reports keep their original wording." },
    ];
    expect(
      glossaryFindings(
        ["docs/decisions/0001-x.md", "docs/guides/a.md"],
        () => "A job.",
        glossary,
        allow([], historical),
      ),
    ).toEqual([
      "historical path docs/guides/** is not one of docs/decisions/**, docs/benchmarks/**",
      'docs/guides/a.md:1 uses "Job"; CONTEXT.md avoids it for **Task**',
      "stale historical path docs/benchmarks/**",
    ]);
  });

  it("finds no unallowed avoid word and no stale entry under docs/", () => {
    const files = execFileSync("git", ["ls-files", "docs/*.md", "docs/**/*.md"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter((file) => file !== "");
    const allowlist = JSON.parse(
      readRepositoryFile("scripts/glossary-allowlist.json"),
    ) as Allowlist;
    expect(
      glossaryFindings(files, readRepositoryFile, readRepositoryFile("CONTEXT.md"), allowlist),
    ).toEqual([]);
  });
});
