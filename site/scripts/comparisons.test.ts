import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { comparisons } from "../lib/comparisons.js";

/**
 * The schema of `site/comparisons.json` (ADR 0104). Every fact on a comparison
 * page comes from this file, so these checks are what stop a page from stating
 * a fact without a source, against no version, or against a Workhorse matrix
 * that says something else.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const docsDir = resolve(repositoryRoot, "site/content/docs");

const workhorseStatuses = new Set(["Supported", "Partial", "Planned", "Not supported", "Absent"]);
const competitorStatuses = new Set(["Supported", "Partial", "Not supported"]);
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A pinned reference: a full commit hash, or a release tag such as `v1.2.3`,
 * `1.2.3`, or `js/v0.2.0`. A branch name moves, so it never matches.
 */
const commitHash = /^[0-9a-f]{40}$/;
const versionTag = /^(?:[a-z][\w-]*\/)?v?\d+(?:\.\d+)+(?:-[\w.]+)?$/;

/** Words ADR 0051 rules out for Workhorse, and superlatives SM-1362 rules out on every page. */
const forbiddenPhrases = [
  /durable execution/i,
  /exactly[- ]once/i,
  /\bbest\b/i,
  /\bfastest\b/i,
  /\bmost (?:reliable|powerful|complete|advanced)\b/i,
  /\bsuperior\b/i,
  /\bunmatched\b/i,
  /\bworld[- ]class\b/i,
  /\bblazing/i,
  /\bleading\b/i,
];

type Cell = Record<string, unknown>;

/** The values that occur more than once. */
const duplicates = (values: readonly string[]) =>
  values.filter((value, index) => values.indexOf(value) !== index);

/** The problems with one competitor cell, each prefixed with `where`. */
function competitorCellErrors(
  cell: Cell,
  kind: "status" | "text",
  version: string,
  where: string,
): string[] {
  const errors: string[] = [];
  if (kind === "status") {
    if (typeof cell.status !== "string" || !competitorStatuses.has(cell.status)) {
      errors.push(`${where}: status ${JSON.stringify(cell.status)} is not a competitor status`);
    }
    if (cell.status !== "Supported" && !cell.note) {
      errors.push(`${where}: a ${String(cell.status)} cell needs a note that says what is missing`);
    }
  } else if (typeof cell.value !== "string" || cell.value.trim() === "") {
    errors.push(`${where}: a text cell needs a value`);
  }
  errors.push(...sourceErrors(cell.source, where));
  if (typeof cell.version !== "string" || cell.version === "") {
    errors.push(`${where}: the cell names no competitor version`);
  } else if (cell.version !== version) {
    errors.push(`${where}: the cell describes ${cell.version}, but the product pins ${version}`);
  }
  if (typeof cell.evidence !== "string" || cell.evidence.trim() === "") {
    errors.push(`${where}: the cell has no evidence from its source`);
  }
  return errors;
}

/**
 * The problems with a source URL. A source is a GitHub file or folder at a
 * release tag or a commit, so the text behind it cannot change after the check.
 * An unversioned docs site does not qualify: cite the repository that builds it,
 * at a commit.
 */
function sourceErrors(source: unknown, where: string): string[] {
  if (typeof source !== "string" || source === "") return [`${where}: the cell has no source URL`];
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return [`${where}: the source ${source} is not a URL`];
  }
  if (url.protocol !== "https:") return [`${where}: the source ${source} is not HTTPS`];
  // The path after the repository: `blob/<ref>/<file>` on github.com, `<ref>/<file>` on
  // raw.githubusercontent.com. A tag can hold one slash, as in `js/v0.2.0`.
  const path =
    url.hostname === "github.com"
      ? /^\/[^/]+\/[^/]+\/(?:blob|tree|raw)\/(.+)$/.exec(url.pathname)?.[1]
      : url.hostname === "raw.githubusercontent.com"
        ? /^\/[^/]+\/[^/]+\/(.+)$/.exec(url.pathname)?.[1]
        : undefined;
  if (path === undefined) {
    return [`${where}: the source ${source} is not a GitHub file at a tag or a commit`];
  }
  const [first = "", second = ""] = path.split("/");
  if (
    !commitHash.test(first) &&
    !versionTag.test(first) &&
    !versionTag.test(`${first}/${second}`)
  ) {
    return [`${where}: the source ${source} names no release tag or commit hash`];
  }
  return [];
}

/** The status of the row named `row` in the Markdown tables of `document`. */
function matrixStatuses(document: string, row: string): string[] {
  const statuses: string[] = [];
  for (const line of document.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells[1] !== row) continue;
    statuses.push(...cells.slice(2, -1).filter((cell) => workhorseStatuses.has(cell)));
  }
  return statuses;
}

const pageExists = (path: string) =>
  readFile(
    resolve(
      docsDir,
      path === "/docs/compare"
        ? "compare/index.mdx"
        : `${path.replace(/^\/docs\//, "").replace(/#.*$/, "")}.mdx`,
    ),
    "utf8",
  ).then(
    () => true,
    () => false,
  );

describe("the comparison data", () => {
  it("rejects a competitor cell without a source URL or a version", () => {
    const complete = {
      status: "Supported",
      source: "https://github.com/owner/repo/blob/v1.2.3/README.md#L1",
      version: "1.2.3",
      evidence: "Jobs are inserted in your transaction.",
    };
    expect(competitorCellErrors(complete, "status", "1.2.3", "cell")).toEqual([]);

    const { source: _source, ...unsourced } = complete;
    expect(competitorCellErrors(unsourced, "status", "1.2.3", "cell")).toEqual([
      "cell: the cell has no source URL",
    ]);
    const { version: _version, ...unversioned } = complete;
    expect(competitorCellErrors(unversioned, "status", "1.2.3", "cell")).toEqual([
      "cell: the cell names no competitor version",
    ]);
    expect(
      competitorCellErrors(
        { ...complete, source: "https://github.com/owner/repo/blob/main/README.md" },
        "status",
        "1.2.3",
        "cell",
      ),
    ).toEqual([
      "cell: the source https://github.com/owner/repo/blob/main/README.md names no release tag or commit hash",
    ]);
    for (const pinned of [
      "https://github.com/owner/repo/blob/1.2.3/README.md",
      "https://github.com/owner/repo/blob/js/v0.2.0/js/README.md",
      `https://github.com/owner/repo/blob/${"a".repeat(40)}/docs/index.md#L5`,
      "https://raw.githubusercontent.com/owner/repo/v1.2.3/README.md",
    ]) {
      expect(
        competitorCellErrors({ ...complete, source: pinned }, "status", "1.2.3", pinned),
      ).toEqual([]);
    }
    for (const moving of ["stable", "feature/new-api", "release-1.x"]) {
      const source = `https://github.com/owner/repo/blob/${moving}/README.md`;
      expect(competitorCellErrors({ ...complete, source }, "status", "1.2.3", "cell")).toEqual([
        `cell: the source ${source} names no release tag or commit hash`,
      ]);
    }
    expect(
      competitorCellErrors(
        { ...complete, source: "https://docs.example.com/queues" },
        "status",
        "1.2.3",
        "cell",
      ),
    ).toEqual([
      "cell: the source https://docs.example.com/queues is not a GitHub file at a tag or a commit",
    ]);
    expect(
      competitorCellErrors({ ...complete, status: "Partial" }, "status", "1.2.3", "cell"),
    ).toEqual(["cell: a Partial cell needs a note that says what is missing"]);
  });

  it("gives every product a complete, sourced, and pinned set of cells", () => {
    const rowIds = new Set(comparisons.rows.map((row) => row.id));
    const errors: string[] = [];
    for (const product of comparisons.products) {
      const where = (row: string) => `${product.slug}.${row}`;
      if (!isoDate.test(product.checked))
        errors.push(`${product.slug}: checked is not an ISO date`);
      if (product.version.trim() === "") errors.push(`${product.slug}: no version`);
      // A planned page needs the hub rows, and a published page needs every
      // core row. Each cell that exists must be complete, required or not.
      for (const row of comparisons.rows) {
        const cell = product.cells[row.id];
        if (cell) {
          errors.push(
            ...competitorCellErrors({ ...cell }, row.kind, product.version, where(row.id)),
          );
        } else if (product.page === "published" || row.hub === true) {
          errors.push(`${where(row.id)}: missing`);
        }
      }
      for (const id of Object.keys(product.cells)) {
        if (!rowIds.has(id)) errors.push(`${where(id)}: no core row has this id`);
      }
      const ownRows = product.rows ?? [];
      if (ownRows.length > 3) errors.push(`${product.slug}: ${ownRows.length} own rows, at most 3`);
      for (const row of ownRows) {
        if (rowIds.has(row.id)) errors.push(`${where(row.id)}: an own row reuses a core row id`);
        errors.push(
          ...competitorCellErrors({ ...row.cell }, row.kind, product.version, where(row.id)),
        );
      }
    }
    expect(errors).toEqual([]);
  });

  it("keeps ids, categories, and groups unique and known", () => {
    const groups = new Set(comparisons.groups.map((group) => group.id));
    const categories = new Set(comparisons.categories.map((category) => category.id));
    const allRows = [...comparisons.rows, ...comparisons.products.flatMap((p) => p.rows ?? [])];

    expect(duplicates(comparisons.rows.map((row) => row.id))).toEqual([]);
    expect(duplicates(comparisons.products.map((product) => product.slug))).toEqual([]);
    expect(duplicates(comparisons.products.map((product) => product.name))).toEqual([]);
    expect(allRows.filter((row) => !groups.has(row.group)).map((row) => row.id)).toEqual([]);
    expect(
      comparisons.products
        .filter((product) => !categories.has(product.category))
        .map((product) => product.slug),
    ).toEqual([]);
    expect(
      comparisons.products
        .map((product) => product.slug)
        .filter((slug) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)),
    ).toEqual([]);
    expect(
      comparisons.categories
        .filter((category) => !comparisons.products.some((p) => p.category === category.id))
        .map((category) => category.id),
    ).toEqual([]);
  });

  it("states each Workhorse status as docs/features.md or docs/parity.md states it", async () => {
    const documents = {
      "docs/features.md": await readFile(resolve(repositoryRoot, "docs/features.md"), "utf8"),
      "docs/parity.md": await readFile(resolve(repositoryRoot, "docs/parity.md"), "utf8"),
    };
    const rows = [...comparisons.rows, ...comparisons.products.flatMap((p) => p.rows ?? [])];
    const errors: string[] = [];
    for (const row of rows) {
      const cell = row.workhorse;
      if (row.kind === "status") {
        if (!("status" in cell)) {
          errors.push(`${row.id}: a status row needs a Workhorse status`);
          continue;
        }
        const statuses = matrixStatuses(documents[cell.feature.doc], cell.feature.row);
        if (statuses.length === 0) {
          errors.push(`${row.id}: ${cell.feature.doc} has no row "${cell.feature.row}"`);
        } else if (!statuses.every((status) => status === cell.status)) {
          errors.push(
            `${row.id}: Workhorse says ${cell.status}, but ${cell.feature.doc} "${cell.feature.row}" says ${statuses.join(", ")}`,
          );
        }
        if (cell.status !== "Supported" && !cell.note) {
          errors.push(`${row.id}: a ${cell.status} Workhorse cell needs a note`);
        }
      } else if (!("value" in cell) || cell.value.trim() === "") {
        errors.push(`${row.id}: a text row needs a Workhorse value`);
      } else {
        const exists = await readFile(resolve(repositoryRoot, cell.source), "utf8").then(
          () => true,
          () => false,
        );
        if (!exists) errors.push(`${row.id}: the Workhorse source ${cell.source} does not exist`);
      }
      if (cell.page && !(await pageExists(cell.page))) {
        errors.push(`${row.id}: the Workhorse page ${cell.page} does not exist`);
      }
    }
    expect(errors).toEqual([]);
  });

  it("names an Issue for each planned page and none for a published page", async () => {
    const pages = new Set(
      (await readdir(resolve(docsDir, "compare")))
        .filter((name) => name.endsWith(".mdx") && name !== "index.mdx")
        .map((name) => name.slice(0, -4)),
    );
    const errors = comparisons.products.flatMap((product) => {
      const published = product.page === "published";
      return [
        ...(published && product.issue ? [`${product.slug}: a published page names an Issue`] : []),
        ...(!published && !/^SM-\d+$/.test(product.issue ?? "")
          ? [`${product.slug}: a planned page names no Issue`]
          : []),
        ...(published !== pages.has(product.slug)
          ? [`${product.slug}: page "${product.page}" disagrees with the files under compare/`]
          : []),
      ];
    });
    expect(errors).toEqual([]);
  });

  it("keeps ADR 0051 wording and has no superlatives in the data or the pages", async () => {
    const files = [
      resolve(repositoryRoot, "site/comparisons.json"),
      ...(await readdir(resolve(docsDir, "compare")))
        .filter((name) => name.endsWith(".mdx"))
        .map((name) => resolve(docsDir, "compare", name)),
    ];
    const errors: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      // Evidence quotes the competitor's own words, which may use these phrases.
      const checked = file.endsWith(".json")
        ? JSON.stringify(
            JSON.parse(text, (key: string, value: unknown) =>
              key === "evidence" ? undefined : value,
            ),
          )
        : text.replaceAll("/docs/durable-execution", "");
      for (const phrase of forbiddenPhrases) {
        if (phrase.test(checked)) errors.push(`${file}: ${String(phrase)}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it("gives each published page the required sections, its table, and the hub link", async () => {
    const errors: string[] = [];
    for (const product of comparisons.products.filter((entry) => entry.page === "published")) {
      const source = await readFile(resolve(docsDir, "compare", `${product.slug}.mdx`), "utf8");
      const required = [
        `title: "Workhorse compared with ${product.name}"`,
        `${product.name} vs Workhorse`,
        `<ComparisonTable product="${product.slug}" />`,
        "](/docs/migrate)",
      ];
      for (const text of required) {
        if (!source.includes(text)) errors.push(`${product.slug}: missing ${text}`);
      }
      // The evaluation comes first, then these two sections in this order.
      const headings = [...source.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
      const better = headings.indexOf(`When ${product.name} is the better choice`);
      const move = headings.indexOf(`Move from ${product.name}`);
      if (!(better > 0 && move > better)) {
        errors.push(`${product.slug}: the sections are not evaluation, better choice, move`);
      }
    }
    expect(errors).toEqual([]);
  });
});
