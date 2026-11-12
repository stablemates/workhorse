import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./packages.js";

// ADR 0054 says that 1.0.0 removes nothing and narrows nothing, and `docs/versioning.md` keeps
// each accumulated removal for the first contract step of the 2.x line. A comment or a document
// that says a name goes in 1.0.0 tells a user to expect a break that does not come (SM-2046).
//
// A released changelog entry keeps its words, so only the `## Unreleased` section of a changelog
// is read. A claim can break across lines, so the check reads each paragraph as one text, without
// the comment or quote marker of each line. A blank line, a list item, and a Markdown heading start
// a new paragraph. In code, comment lines and the lines of a `"""` docstring join. A sentence of a
// paragraph is a claim when it names a removal and the version 1.0.0, and has no negation such as
// "nothing" or "not" and no 2.x contract step.
//
// This check is a regression guard for the forms that the repository used, not a parser of English,
// so an unusual sentence can pass it or fail it (SM-2046).

const version = /(?<![\w.])v?1\.0(?:\.0)?(?![.\d]*\d)/;
const removal = /\b(?:remov(?:e|ed|es|ing)|delet(?:e|ed|es|ing)|drop(?:s|ped|ping)?)\b/i;
/** A sentence that says nothing goes in 1.0.0 states the rule of ADR 0054, not a claim. */
const negation = /\b(?:nothing|no|not|never|none)\b/i;
/** A sentence that names the 2.x contract step says when a removal can come, which is the rule. */
const laterStep = /\b2\.x\b|\bcontract step\b/i;

const changelog = /^(?:.+\/)?CHANGELOG\.md$/;
/** The comment marker at the start of a line of code, such as `//`, ` * `, `#`, or `--`. */
const codeMarker = /^\s*(?:\/\/+|\/?\*+\/?|#+|--)?\s*/;
/** The quote markers at the start of a Markdown line. */
const quoteMarker = /^\s*(?:>\s*)*/;
const comment = /^\s*(?:\/\/|\/?\*|#|--)/;
const listItem = /^(?:[-*+]|\d+[.)])\s/;
/** Text that names a removal and 1.0.0 but no API name, each with the reason it is not a claim. */
const allowed: readonly { path: string; text: string; reason: string }[] = [
  {
    path: "docs/decisions/0034-reset-the-pre-release-schema-baseline.md",
    text: "Delete the migration framework until 1.0.0",
    reason: "A heading of a historical record about the migration framework, not an API name.",
  },
];
const thisFile = "scripts/deprecation-removal-claims.test.ts";

/** The text of `file` that this check reads: all of it, or the unreleased part of a changelog. */
function checkedText(file: string, text: string): string {
  if (!changelog.test(file)) return text;
  const start = text.indexOf("\n## Unreleased");
  if (start === -1) return "";
  const end = text.indexOf("\n## ", start + 1);
  // Keep the line numbers of the file, so a finding names the real line.
  const before = text.slice(0, start).replace(/[^\n]/g, "");
  return before + text.slice(start, end === -1 ? undefined : end);
}

interface Paragraph {
  text: string;
  /** Where each line starts in `text`, and its line number in the file. */
  lines: { offset: number; line: number }[];
}

function paragraphs(file: string, text: string): Paragraph[] {
  const markdown = /\.mdx?$/.test(file);
  const found: Paragraph[] = [];
  let current: Paragraph | undefined;
  let docstring = false;
  checkedText(file, text)
    .split("\n")
    .forEach((raw, index) => {
      const heading = markdown && /^\s*#{1,6}\s/.test(raw);
      // A line that opens, continues, or closes a `"""` docstring is prose.
      const quotes = raw.split('"""').length - 1;
      const inDocstring = docstring || quotes > 0;
      if (quotes % 2 === 1) docstring = !docstring;
      // In code, only comment and docstring lines join: each other line stands alone.
      const alone = !markdown && !comment.test(raw) && !inDocstring;
      const stripped = raw
        .replace(markdown ? quoteMarker : codeMarker, "")
        .replace(/^"""|"""$/g, "")
        .trim();
      if (stripped === "" || heading || alone || listItem.test(stripped)) current = undefined;
      if (stripped === "") return;
      if (current === undefined) {
        current = { text: "", lines: [] };
        found.push(current);
      }
      if (current.text !== "") current.text += " ";
      current.lines.push({ offset: current.text.length, line: index + 1 });
      current.text += stripped;
      if (heading || alone) current = undefined;
    });
  return found;
}

/**
 * Whether `sentence` says that a name goes in 1.0.0: it names a removal and the version 1.0.0, and
 * it has no negation.
 */
function isClaim(sentence: string): boolean {
  const plain = sentence.replace(/`/g, "");
  return (
    removal.test(plain) && version.test(plain) && !negation.test(plain) && !laterStep.test(plain)
  );
}

/** Each line of `files` where a sentence that says a name goes in 1.0.0 starts. */
function violations(files: readonly { path: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (file.path === thisFile) continue;
    const lines = new Set<number>();
    for (const paragraph of paragraphs(file.path, file.text)) {
      // A sentence ends at `.`, `!`, or `?` before a space, so `1.0.0` stays one token.
      for (const sentence of paragraph.text.matchAll(
        /[^.!?]*(?:[.!?](?!\s|$)[^.!?]*)*(?:[.!?]|$)/g,
      )) {
        if (sentence[0].trim() === "" || !isClaim(sentence[0])) continue;
        if (allowed.some((entry) => entry.path === file.path && sentence[0].includes(entry.text)))
          continue;
        const begin = sentence.index + sentence[0].search(/\S/);
        const start = paragraph.lines.findLast(({ offset }) => offset <= begin);
        if (start !== undefined) lines.add(start.line);
      }
    }
    for (const line of [...lines].toSorted((left, right) => left - right)) {
      found.push(`${file.path}:${line}`);
    }
  }
  return found;
}

describe("removal claims for 1.0.0", () => {
  it("finds each form of the claim and leaves the rule and other versions alone", () => {
    const released = "# Changelog\n\n## Unreleased\n\nNothing.\n\n## 0.9.0\n\nRemoved in 1.0.0.\n";
    const unreleased = "# Changelog\n\n## Unreleased\n\n`Old` is removed in `1.0.0`.\n\n## 0.9.0\n";
    expect(
      violations([
        { path: "a.ts", text: "/** @deprecated Use `next`. Removed in 1.0.0. */" },
        {
          path: "b.md",
          text: "It remains for the rest of the `0.x` line.\nWorkhorse removes it in `1.0.0`.",
        },
        { path: "c.md", text: "Version `1.0.0` removes it." },
        { path: "d.py", text: '"""Deprecated. Renamed to ``New``. Removed in v1.0."""' },
        { path: "e.md", text: "1.0.0 removes nothing and narrows nothing. 1.0.0 removes no name." },
        { path: "f.md", text: "0.11.0 removes the opt-out. It was removed in 0.11.0." },
        { path: "g.md", text: "The name stays through the 1.x line." },
        {
          path: "h.ts",
          text: "// Each is a type alias of its replacement and is removed in\n// 1.0.0.\nconst a = 1;",
        },
        { path: "i.md", text: "> The old name remains an alias and is removed\n> in 1.0.0." },
        { path: "j.md", text: "The alias is removed\nin\n1.0.0." },
        { path: "k.md", text: "`Old` is removed as of 1.0.0. 1.0.0 will remove `Older`." },
        { path: "l.md", text: "Nothing is removed in\n1.0.0. No name is removed in 1.0.0." },
        {
          path: "m.md",
          text: "- The old name is removed\n- In 1.0.0 the new name is the only one",
        },
        { path: "n.md", text: "## Removed\n\nIn 1.0.0 the new name stays." },
        {
          path: "o.md",
          text: "Workhorse removes the deprecated `EnqueueIdempotency` alias in 1.0.0.",
        },
        { path: "p.md", text: "In 1.0.0, Workhorse removes `Old`." },
        { path: "q.py", text: '"""The alias is removed in ``1.0.0``."""' },
        {
          path: "r.md",
          text: "No deprecated names are removed in 1.0.0. Nothing will be removed in 1.0.0.",
        },
        {
          path: "s.ts",
          text: "// - The old name was removed\n// - In 1.0.0 the new name is the only one",
        },
        {
          path: "t.py",
          text: "# - The old name was removed\n# - In 1.0.0 the new name is the only one",
        },
        {
          path: "u.md",
          text: "> * The old name was removed\n> * In 1.0.0 the new name is the only one",
        },
        { path: "v.json", text: '{\n  "a": "removed",\n  "b": "1.0.0"\n}' },
        {
          path: "w.py",
          text: 'x = 1\n"""Deprecated.\n\nThe alias is removed in\n1.0.0.\n"""\ny = 2',
        },
        {
          path: "x.md",
          text: "The deprecated `Old` alias is removed without replacement in 1.0.0.",
        },
        {
          path: "y.md",
          text: "The name stays through 1.0.0 and can be removed at the first contract step of the 2.x line.",
        },
        { path: "docs/decisions/0001-x.md", text: "The alias is removed in 1.0.0." },
        { path: "ruby/CHANGELOG.md", text: released },
        { path: "python/CHANGELOG.md", text: unreleased },
      ]),
    ).toEqual([
      "a.ts:1",
      "b.md:2",
      "c.md:1",
      "d.py:1",
      "h.ts:1",
      "i.md:1",
      "j.md:1",
      "k.md:1",
      "o.md:1",
      "p.md:1",
      "q.py:1",
      "w.py:4",
      "x.md:1",
      "docs/decisions/0001-x.md:1",
      "python/CHANGELOG.md:5",
    ]);
  });

  it("finds no removal claim for 1.0.0 in the repository", () => {
    const paths = execFileSync("git", ["ls-files", "-z"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((file) => file !== "");
    const files = paths.flatMap((file) => {
      let text: string;
      try {
        text = readFileSync(path.join(repositoryRoot, file), "utf8");
      } catch {
        // A file deleted in the working tree is not content anyone ships.
        return [];
      }
      // Binary files hold no prose.
      return text.includes("\0") ? [] : [{ path: file, text }];
    });
    expect(violations(files)).toEqual([]);
  });
});
