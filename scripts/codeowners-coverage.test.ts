import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The files that decide what CI and the release jobs run must have a code owner (SM-1965).
 *
 * The `Protect main` ruleset requires a review from a code owner, so `.github/CODEOWNERS` puts a
 * maintainer in front of each path it names. A change to the lane plan, the matrix, the toolchain,
 * the schema, or the protocol can make CI skip a suite while every test still passes. This test
 * fails when one of those paths has no owner, and when a workflow starts to run a script that has
 * no owner.
 */

const repository = path.resolve(import.meta.dirname, "..");

/** The paths that decide the CI lanes, the matrix, the toolchain, the protocol, or a release. */
const ciPlanFiles = [
  ".github/CODEOWNERS",
  ".github/workflows/ci.yml",
  "scripts/ci-lanes.ts",
  "scripts/ci-matrix.ts",
  "scripts/check-main-ci-plan.ts",
  "scripts/publish-npm.ts",
  "mise.toml",
  "support.json",
  "Dockerfile",
  "Dockerfile.dashboard",
  "Dockerfile.site",
  "typescript/demo/DEPLOYMENT.md",
  "pnpm-lock.yaml",
  "python/uv.lock",
  "go/go.sum",
];

/** The directories whose every file needs an owner. */
const ownedDirectories = ["sql", "protocol"];

/** One rule of a CODEOWNERS file: a path pattern and the owners it names. */
interface OwnerRule {
  readonly line: number;
  readonly pattern: string;
  readonly owners: readonly string[];
  readonly matches: RegExp;
}

/** The regular expression of one path segment pattern, with `*` and `?` inside the segment. */
function segmentSource(segment: string): string {
  if (segment === "**") return ".*";
  return segment
    .split("")
    .map((character) => {
      if (character === "*") return "[^/]*";
      if (character === "?") return "[^/]";
      return character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
}

/**
 * Compile a pattern with the gitignore rules that CODEOWNERS uses. A leading `/` or an inner `/`
 * anchors the pattern at the repository root. A pattern with no `/` matches at any depth. A pattern
 * also matches every file below the directory it names.
 */
function compilePattern(pattern: string): RegExp {
  const directoryOnly = pattern.endsWith("/");
  const trimmed = pattern.replace(/^\//, "").replace(/\/$/, "");
  const anchored = pattern.startsWith("/") || trimmed.includes("/");
  // An inner `**` also matches no directory, so `a/**/b` matches `a/b`.
  const body = trimmed.split("/").map(segmentSource).join("/").replaceAll("/.*/", "/(?:.*/)?");
  const prefix = anchored ? "^" : "^(?:.*/)?";
  const suffix = directoryOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(`${prefix}${body}${suffix}`);
}

function parseCodeowners(text: string): OwnerRule[] {
  return text.split("\n").flatMap((raw, index) => {
    const content = raw.replace(/(^|\s)#.*$/, "").trim();
    if (content === "") return [];
    const [pattern = "", ...owners] = content.split(/\s+/);
    return [{ line: index + 1, pattern, owners, matches: compilePattern(pattern) }];
  });
}

/** The owners of `file`. The last rule that matches wins, as on GitHub. */
function ownersOf(rules: readonly OwnerRule[], file: string): readonly string[] {
  return rules.findLast((rule) => rule.matches.test(file))?.owners ?? [];
}

/** The paths of `rules` that have no owner. */
function unowned(rules: readonly OwnerRule[], files: readonly string[]): string[] {
  return files.filter((file) => ownersOf(rules, file).length === 0);
}

/**
 * The repository scripts that `workflow` names by path. A path can start with `./`,
 * `$GITHUB_WORKSPACE/`, or `${{ github.workspace }}/`. A path inside a URL, such as
 * `dotnet/scripts/v1/dotnet-install.sh`, is not a repository path. A test file that a comment
 * names is not a script that the workflow runs.
 */
function scriptPathsIn(workflow: string): string[] {
  const prefix = String.raw`(?:\./|\$\{?GITHUB_WORKSPACE\}?/|\$\{\{\s*github\.workspace\s*\}\}/)?`;
  const script = new RegExp(
    String.raw`(?<![\w./-])${prefix}(scripts/[\w./-]+\.(?:ts|sh|py|mjs|js))\b`,
    "g",
  );
  return [...workflow.matchAll(script)]
    .map((match) => match[1] ?? "")
    .filter((file) => file !== "" && !file.includes(".test."));
}

/** Every repository script that a workflow runs by its path. */
async function scriptsThatWorkflowsRun(): Promise<string[]> {
  const directory = path.join(repository, ".github/workflows");
  const scripts = new Set<string>();
  for (const name of await readdir(directory)) {
    if (!/\.ya?ml$/.test(name)) continue;
    for (const file of scriptPathsIn(await readFile(path.join(directory, name), "utf8"))) {
      scripts.add(file);
    }
  }
  return [...scripts].toSorted();
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(repository, directory), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(repository, path.join(entry.parentPath, entry.name)))
    .toSorted();
}

async function requiredPaths(): Promise<string[]> {
  const below = await Promise.all(ownedDirectories.map(filesBelow));
  return [...ciPlanFiles, ...(await scriptsThatWorkflowsRun()), ...below.flat()];
}

async function readRules(): Promise<OwnerRule[]> {
  return parseCodeowners(await readFile(path.join(repository, ".github/CODEOWNERS"), "utf8"));
}

describe("code owners of the CI plan", () => {
  it("names an owner for each file that decides what CI and the release jobs run", async () => {
    expect(unowned(await readRules(), await requiredPaths())).toEqual([]);
  });

  it("finds the scripts that the workflows run", async () => {
    const scripts = await scriptsThatWorkflowsRun();
    expect(scripts).toContain("scripts/ci-lanes.ts");
    expect(scripts).toContain("scripts/check-main-ci-plan.ts");
    for (const script of scripts) {
      await expect(readFile(path.join(repository, script))).resolves.toBeDefined();
    }
  });

  it("reads each form of a script path that a workflow can run", () => {
    const workflow = [
      "run: pnpm exec tsx scripts/ci-lanes.ts pull_request",
      "run: tsx ./scripts/new-plan.ts",
      "run: node $GITHUB_WORKSPACE/scripts/a.mjs && sh ${GITHUB_WORKSPACE}/scripts/b.sh",
      "run: tsx ${{ github.workspace }}/scripts/c.ts",
      "run: curl https://example.test/dotnet/scripts/v1/dotnet-install.sh",
      "# scripts/ci-lanes.test.ts holds the map to this workflow.",
    ].join("\n");
    expect(scriptPathsIn(workflow)).toEqual([
      "scripts/ci-lanes.ts",
      "scripts/new-plan.ts",
      "scripts/a.mjs",
      "scripts/b.sh",
      "scripts/c.ts",
    ]);
    expect(unowned(parseCodeowners("/scripts/ci-lanes.ts @a\n"), scriptPathsIn(workflow))).toEqual([
      "scripts/new-plan.ts",
      "scripts/a.mjs",
      "scripts/b.sh",
      "scripts/c.ts",
    ]);
  });

  it("fails when a copy of CODEOWNERS loses one of the CI plan rules", async () => {
    // The rules that SM-1965 requires. Another rule can be added or can overlap with these, so the
    // case removes only these, one at a time, from a copy of the file.
    const required = [
      "/scripts/ci-lanes.ts",
      "/scripts/ci-matrix.ts",
      "/scripts/check-main-ci-plan.ts",
      "/mise.toml",
      "/support.json",
      "/sql/",
      "/protocol/",
    ];
    const rules = await readRules();
    const paths = await requiredPaths();
    for (const pattern of required) {
      const copy = rules.filter((candidate) => candidate.pattern !== pattern);
      expect({ pattern, removed: copy.length < rules.length }).toEqual({ pattern, removed: true });
      expect({ pattern, unowned: unowned(copy, paths).length > 0 }).toEqual({
        pattern,
        unowned: true,
      });
    }
  });

  it("accepts an extra or an overlapping rule", async () => {
    const rules = [
      ...(await readRules()),
      ...parseCodeowners("/SECURITY.md @a\n/sql/releases/ @a\n"),
    ];
    expect(unowned(rules, await requiredPaths())).toEqual([]);
  });

  it("fails when a later rule removes the owners of a path", async () => {
    const rules = [...(await readRules()), ...parseCodeowners("/support.json\n")];
    expect(unowned(rules, await requiredPaths())).toEqual(["support.json"]);
  });

  it("matches patterns as GitHub does", () => {
    const rules = parseCodeowners(
      ["/sql/ @a", "/Dockerfile @a", "*.lock @b", "docs/*.md @c", "/go/**/go.sum @d"].join("\n"),
    );
    expect(ownersOf(rules, "sql/releases/0091.sql")).toEqual(["@a"]);
    expect(ownersOf(rules, "sqlite/x.sql")).toEqual([]);
    expect(ownersOf(rules, "Dockerfile")).toEqual(["@a"]);
    expect(ownersOf(rules, "Dockerfile.site")).toEqual([]);
    expect(ownersOf(rules, "ruby/gemfiles/rails.lock")).toEqual(["@b"]);
    expect(ownersOf(rules, "docs/releasing.md")).toEqual(["@c"]);
    expect(ownersOf(rules, "docs/guides/010-tasks.md")).toEqual([]);
    expect(ownersOf(rules, "go/go.sum")).toEqual(["@d"]);
    expect(ownersOf(rules, "go/examples/go.sum")).toEqual(["@d"]);
  });
});
