import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  landingFeatureSnippets,
  landingSnippetLanguages,
  landingSnippets,
  landingSupplementalSnippets,
} from "../lib/landing-snippets.js";
import type { LandingSnippetId } from "../lib/landing-snippets.js";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(siteRoot, "..");
const execFileAsync = promisify(execFile);
const supportManifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, "support.json"), "utf8"),
) as {
  support: { go: { minimum: string } };
};
const quickstartSource = readFileSync(resolve(siteRoot, "content/docs/quickstart.mdx"), "utf8");
const examplesSource = readFileSync(resolve(siteRoot, "content/docs/examples.mdx"), "utf8");
const agentIntegrationSource = readFileSync(
  resolve(siteRoot, "content/docs/for-ai-agents.mdx"),
  "utf8",
);
const documentationSources = [quickstartSource, examplesSource, agentIntegrationSource];
const pythonPublicSource = ["client.py", "admin.py", "worker.py", "types.py"]
  .map((path) => readFileSync(resolve(repositoryRoot, "python/src/workhorse", path), "utf8"))
  .join("\n");
const goPublicSource = [
  "admin_protocol.go",
  "batch.go",
  "child_jobs.go",
  "contracts.go",
  "durability.go",
  "external_waits.go",
  "policies.go",
  "queue.go",
  "worker.go",
]
  .map((path) => readFileSync(resolve(repositoryRoot, "go", path), "utf8"))
  .join("\n");
// Readers copy Go out of the documentation and into an editor, where gofmt rewrites anything it did
// not already agree with. Every `go` fence therefore has to be gofmt output already. Most fences are
// fragments rather than whole files, so each one is offered to gofmt inside the smallest wrapper that
// makes it a program, and the wrapper is stripped back off before the comparison.
const goPackageClause = "package guide";

function runGofmt(source: string): string | undefined {
  const result = spawnSync("gofmt", { input: source, encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}

function withoutPackageClause(formatted: string): string {
  return formatted.replace(/\n+$/, "").split("\n").slice(1).join("\n").replace(/^\n+/, "");
}

function withoutFunctionWrapper(formatted: string): string {
  // Drops the package clause, the blank line after it, `func example() {`, and the closing brace,
  // then removes the one tab of indentation the wrapper added to every line it held.
  return formatted
    .replace(/\n+$/, "")
    .split("\n")
    .slice(3, -1)
    .map((line) => (line.startsWith("\t") ? line.slice(1) : line))
    .join("\n");
}

function formattedGoSnippet(label: string, snippet: string): string {
  const body = `${snippet.replace(/\n+$/, "")}\n`;
  if (/^package\s+\w/.test(body)) {
    const wholeFile = runGofmt(body);
    if (wholeFile !== undefined) return wholeFile.replace(/\n+$/, "");
  }
  const statements = runGofmt(`${goPackageClause}\n\nfunc example() {\n${body}}\n`);
  if (statements !== undefined) return withoutFunctionWrapper(statements);
  const declarations = runGofmt(`${goPackageClause}\n\n${body}`);
  if (declarations !== undefined) return withoutPackageClause(declarations);
  // An import block ahead of statements is neither a declaration list nor a function body, so the
  // two halves are formatted separately and rejoined across the blank line that already parts them.
  const halves = body.match(/^(import\s+(?:\([\s\S]*?\n\)|"[^"]*"))\n+([\s\S]*)$/);
  if (halves) {
    const imports = runGofmt(`${goPackageClause}\n\n${halves[1]!}\n`);
    const rest = runGofmt(
      `${goPackageClause}\n\nfunc example() {\n${halves[2]!.replace(/\n+$/, "")}\n}\n`,
    );
    if (imports !== undefined && rest !== undefined) {
      return `${withoutPackageClause(imports)}\n\n${withoutFunctionWrapper(rest)}`;
    }
  }
  throw new Error(`${label} does not parse as Go, so gofmt cannot format it`);
}

function firstDifferingLine(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  for (let index = 0; index < Math.max(expectedLines.length, actualLines.length); index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return `line ${index + 1}\n  documentation: ${JSON.stringify(actualLines[index] ?? null)}\n  gofmt:         ${JSON.stringify(expectedLines[index] ?? null)}`;
    }
  }
  return "no differing line";
}

const goFencePaths = [
  ...readdirSync(resolve(siteRoot, "content/docs"))
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => `site/content/docs/${name}`),
  ...readdirSync(resolve(repositoryRoot, "docs/guides"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/guides/${name}`),
].toSorted();

let inspectedGoFences = 0;
for (const fencePath of goFencePaths) {
  const source = readFileSync(resolve(repositoryRoot, fencePath), "utf8");
  const backticks = "`".repeat(3);
  const declared = [...source.matchAll(new RegExp(`^[ \\t]*${backticks}go\\b`, "gm"))].length;
  const fences = [
    ...source.matchAll(
      new RegExp(
        `^([ \\t]*)${backticks}go\\b[^\\n]*\\n([\\s\\S]*?)\\n[ \\t]*${backticks}[ \\t]*$`,
        "gm",
      ),
    ),
  ];
  if (fences.length !== declared) {
    throw new Error(`${fencePath} has a Go fence this check could not read`);
  }
  for (const [index, fence] of fences.entries()) {
    const fenceIndent = fence[1]!;
    const code = fence[2]!;
    const label = `${fencePath} Go example ${index + 1}`;
    // A fence may be indented inside an MDX tab while its body still starts at column 0. Whichever
    // base indent the block already uses is the one the reformatted block keeps.
    const populated = code.split("\n").filter((line) => line.trim() !== "");
    const baseIndent =
      fenceIndent !== "" && populated.every((line) => line.startsWith(fenceIndent))
        ? fenceIndent
        : "";
    const snippet = code
      .split("\n")
      .map((line) =>
        line.startsWith(baseIndent) ? line.slice(baseIndent.length) : line.trimStart(),
      )
      .join("\n");
    const expected = formattedGoSnippet(label, snippet)
      .split("\n")
      .map((line) => (line.trim() === "" ? "" : baseIndent + line))
      .join("\n");
    if (expected !== code) {
      throw new Error(`${label} is not gofmt-formatted: ${firstDifferingLine(expected, code)}`);
    }
    inspectedGoFences += 1;
  }
}
if (inspectedGoFences === 0)
  throw new Error("the documentation has no Go examples to format-check");

const crossSdkGuidePaths = [
  "agentic-flow.mdx",
  "batch-handlers.mdx",
  "cancellation.mdx",
  "child-jobs.mdx",
  "concurrency-policies.mdx",
  "contracts.mdx",
  "dead-letters.mdx",
  "deadlines.mdx",
  "debounce.mdx",
  "durable-execution.mdx",
  "enqueue.mdx",
  "human-waits.mdx",
  "idempotency.mdx",
  "job-dependencies.mdx",
  "operations.mdx",
  "priority.mdx",
  "progress.mdx",
  "queue-health.mdx",
  "rate-limits.mdx",
  "retries.mdx",
  "schedules.mdx",
  "signals.mdx",
  "throttle.mdx",
  "workers.mdx",
] as const;
const allowedTypeScriptOnlyExamples: Partial<Record<(typeof crossSdkGuidePaths)[number], number>> =
  {
    // The typed rate-limit status projection is currently a TypeScript-only client API.
    "rate-limits.mdx": 1,
  };

for (const guidePath of crossSdkGuidePaths) {
  const source = readFileSync(resolve(siteRoot, "content/docs", guidePath), "utf8");
  const languageTabs = [
    ...source.matchAll(/<Tabs items=\{\["TypeScript", "Python", "Go"\]\}>([\s\S]*?)<\/Tabs>/g),
  ];
  if (languageTabs.length === 0) throw new Error(`${guidePath} has no cross-SDK feature examples`);
  const typeScriptFenceCount = [...source.matchAll(/^\s*```ts(?:\s|$)/gm)].length;
  const allowedTypeScriptOnly = allowedTypeScriptOnlyExamples[guidePath] ?? 0;
  if (typeScriptFenceCount !== languageTabs.length + allowedTypeScriptOnly) {
    throw new Error(`${guidePath} has an unexpected TypeScript-only feature example`);
  }
  for (const [groupIndex, tabsMatch] of languageTabs.entries()) {
    const tabs = tabsMatch[1] ?? "";
    for (const [tab, language] of [
      ["TypeScript", "ts"],
      ["Python", "python"],
      ["Go", "go"],
    ] as const) {
      const marker = `<Tab value="${tab}">`;
      const tabStart = tabs.indexOf(marker);
      const tabEnd = tabs.indexOf("</Tab>", tabStart);
      const tabSource = tabStart === -1 || tabEnd === -1 ? "" : tabs.slice(tabStart, tabEnd);
      const code = tabSource.match(
        new RegExp(`${"`".repeat(3)}${language}(?: verify)?\\n([\\s\\S]+?)\\n\\s*${"`".repeat(3)}`),
      )?.[1];
      if (!code?.trim()) {
        throw new Error(`${guidePath} language group ${groupIndex + 1} has no ${tab} example`);
      }
      const unindented = code.replace(/^ {4}/gm, "");
      if (language === "python") {
        execFileSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
          input: unindented,
          stdio: ["pipe", "inherit", "inherit"],
        });
        for (const match of unindented.matchAll(/\b(?:queue|admin|worker|context)\.([a-z_]\w*)/g)) {
          const name = match[1]!;
          if (name === "cancellation") continue;
          if (!new RegExp(`\\bdef ${name}\\(`).test(pythonPublicSource)) {
            throw new Error(`${guidePath} uses unknown Python Workhorse method ${name}`);
          }
        }
        for (const match of unindented.matchAll(/\b([A-Z]\w+)\(/g)) {
          const name = match[1]!;
          if (!new RegExp(`\\bclass ${name}\\b`).test(pythonPublicSource)) {
            throw new Error(`${guidePath} uses unknown Python Workhorse type ${name}`);
          }
        }
      } else if (language === "go") {
        // The fence sweep above already proved this snippet parses and is gofmt output.
        for (const match of unindented.matchAll(/\b(?:queue|admin|worker|handler)\.([A-Z]\w*)/g)) {
          const name = match[1]!;
          if (name === "Job") continue;
          if (!new RegExp(`\\bfunc \\([^)]*\\) ${name}\\(`).test(goPublicSource)) {
            throw new Error(`${guidePath} uses unknown Go Workhorse method ${name}`);
          }
        }
        for (const match of unindented.matchAll(/\bworkhorse\.([A-Z]\w*)/g)) {
          const name = match[1]!;
          if (!new RegExp(`\\b${name}\\b`).test(goPublicSource)) {
            throw new Error(`${guidePath} uses unknown Go Workhorse symbol ${name}`);
          }
        }
      }
    }
  }
}

function assertVerifiedLanguageSnippets(
  name: string,
  snippets: { typescript: LandingSnippetId; python?: LandingSnippetId; go?: LandingSnippetId },
) {
  if (
    snippets.python === undefined ||
    snippets.go === undefined ||
    landingSnippetLanguages[snippets.python] !== "python" ||
    landingSnippetLanguages[snippets.go] !== "go"
  ) {
    throw new Error(`landing example ${name} has unverified language snippets`);
  }
}

for (const [name, snippets] of Object.entries(landingFeatureSnippets)) {
  assertVerifiedLanguageSnippets(name, snippets);
}
for (const [name, snippets] of Object.entries(landingSupplementalSnippets)) {
  assertVerifiedLanguageSnippets(name, snippets);
}

const examplePatterns = examplesSource
  .split(/\n(?=## )/)
  .filter((section) => section.startsWith("## ") && !section.startsWith("## Next"));

for (const pattern of examplePatterns) {
  const title = pattern.match(/^## (.+)$/m)?.[1] ?? "unknown example";
  for (const [tab, language, verification] of [
    ["TypeScript", "ts", ""],
    ["Python", "python", " verify"],
    ["Go", "go", " verify"],
  ] as const) {
    const marker = `<Tab value="${tab}">`;
    const tabStart = pattern.indexOf(marker);
    const tabEnd = pattern.indexOf("</Tab>", tabStart + marker.length);
    const tabSource = tabStart === -1 || tabEnd === -1 ? "" : pattern.slice(tabStart, tabEnd);
    const fence = "`".repeat(3);
    const code = tabSource.match(
      new RegExp(`${fence}${language}${verification}\\n([\\s\\S]+?)\\n\\s*${fence}`),
    )?.[1];
    if (!code?.trim()) {
      throw new Error(`${title} has no ${tab} example`);
    }
  }
}

// The agent playbook page names SDK identifiers in prose that no compiler sees. Tier 1 is the
// compilation of its `verify` fences below. Tier 2 requires every backticked identifier the prose
// attributes to a language to appear in that language's `verify` fence on the same page. Tier 3
// admits the identifiers no fence exercises through a fixed allowlist, and each entry names the
// source file that must still define it.
type PlaybookLanguage = "ts" | "python" | "go";
const playbookLanguageNames: Record<string, PlaybookLanguage> = {
  TypeScript: "ts",
  Python: "python",
  Go: "go",
};
const playbookLanguagePattern = /TypeScript|Python|Go/g;
// Identifiers named in the playbook's prose that its fences do not exercise, paired with the source
// file that defines each one. An entry the prose no longer needs fails the check, so the list cannot
// outlive the sentence it serves.
const playbookProseAllowlist: Record<string, string> = {
  // The example never asserts schema compatibility, because the schema is installed by deployment.
  assertSchemaCompatible: "typescript/core/src/schema.ts",
  assert_schema_compatible: "python/src/workhorse/compatibility.py",
  AssertSchemaCompatible: "go/compatibility.go",
  // Enqueue bounds the example does not set. Prose with no language attribution is read as the
  // TypeScript spelling, which is the spelling the cross-SDK pages lead with.
  deadline: "typescript/core/src/types.ts",
  executionTimeoutMs: "typescript/core/src/types.ts",
  // An HTTP header, not an SDK name. ADR 0049 records that the Markdown twin does not negotiate on it.
  Accept: "docs/decisions/0049-publish-one-agent-documentation-layer.md",
};
const playbookFences = Object.fromEntries(
  (["ts", "python", "go"] as const).map((language) => {
    const fence = "`".repeat(3);
    const matches = [
      ...agentIntegrationSource.matchAll(
        new RegExp(`${fence}${language} verify\\n([\\s\\S]*?)\\n {0,4}${fence}`, "g"),
      ),
    ];
    if (matches.length !== 1) {
      throw new Error(`for-ai-agents.mdx must hold exactly one ${language} verify fence`);
    }
    return [language, matches[0]![1]!];
  }),
) as Record<PlaybookLanguage, string>;
const playbookProse = agentIntegrationSource
  .replace(/^---\n[\s\S]*?\n---\n/, "")
  .replace(/^ {0,4}`{3}[^\n]*\n[\s\S]*?\n {0,4}`{3}$/gm, "");
const playbookSentences = playbookProse
  .split(/\n\s*\n/)
  .flatMap((paragraph) => paragraph.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/));
const consultedAllowlist = new Set<string>();

function playbookProseLanguages(sentence: string, start: number, end: number): PlaybookLanguage[] {
  // "`name` in TypeScript and Python" attributes the span to the languages that follow it. Failing
  // that, the nearest language named earlier in the sentence owns it, as in "Go wraps ... `name`".
  const following = sentence
    .slice(end)
    .match(/^ in ((?:(?:TypeScript|Python|Go)(?:,? (?:and|or) |, ))*(?:TypeScript|Python|Go))/);
  const attributed = following
    ? [...following[1]!.matchAll(playbookLanguagePattern)].map((match) => match[0])
    : [...sentence.slice(0, start).matchAll(playbookLanguagePattern)].slice(-1).map((m) => m[0]);
  return attributed.length > 0 ? attributed.map((name) => playbookLanguageNames[name]!) : ["ts"];
}

function playbookFenceUses(fence: string, identifier: string): boolean {
  // `Admin.getJob` is satisfied by `new Admin(pool).getJob(jobId)`: the member must appear as a
  // whole word, and each qualifier may end a longer name such as `NewAdmin`.
  const segments = identifier.replace(/\(.*\)$/, "").split(".");
  const member = segments.pop()!;
  return (
    new RegExp(`\\b${member}\\b`).test(fence) &&
    segments.every((qualifier) => new RegExp(`${qualifier}\\b`).test(fence))
  );
}

for (const sentence of playbookSentences) {
  for (const match of sentence.matchAll(/`([^`]+)`/g)) {
    const span = match[1]!;
    if (!/^[A-Za-z_][\w.]*(?:\([^()]*\))?$/.test(span)) continue;
    for (const language of playbookProseLanguages(
      sentence,
      match.index,
      match.index + match[0].length,
    )) {
      if (playbookFenceUses(playbookFences[language], span)) continue;
      const sourcePath = playbookProseAllowlist[span];
      if (sourcePath === undefined) {
        throw new Error(
          `for-ai-agents.mdx names ${span} for ${language} but no ${language} verify fence uses it`,
        );
      }
      consultedAllowlist.add(span);
      const source = readFileSync(resolve(repositoryRoot, sourcePath), "utf8");
      if (!new RegExp(`\\b${span}\\b`).test(source)) {
        throw new Error(`for-ai-agents.mdx names ${span}, which ${sourcePath} no longer defines`);
      }
    }
  }
}
for (const name of Object.keys(playbookProseAllowlist)) {
  if (!consultedAllowlist.has(name)) {
    throw new Error(`for-ai-agents.mdx no longer needs the allowlist entry for ${name}`);
  }
}

function verifiedDocumentationExamples(language: "ts" | "python" | "go"): string[] {
  const fence = "`".repeat(3);
  const pattern = new RegExp(`${fence}${language} verify\\n([\\s\\S]*?)\\n {0,4}${fence}`, "g");
  const examples = documentationSources.flatMap((source) =>
    [...source.matchAll(pattern)].map((match) => match[1]!.replace(/^ {4}/gm, "")),
  );
  if (examples.length === 0) throw new Error(`documentation has no verified ${language} example`);
  return examples;
}

const temporaryRoot = mkdtempSync(resolve(tmpdir(), "workhorse-doc-examples-"));
try {
  const typeScriptExamples = verifiedDocumentationExamples("ts");
  const typeScriptPaths: string[] = [];
  for (const [index, example] of typeScriptExamples.entries()) {
    const typeScriptPath = resolve(temporaryRoot, `example-${index}.ts`);
    writeFileSync(typeScriptPath, `${example}\n`);
    typeScriptPaths.push(typeScriptPath);
  }
  writeFileSync(resolve(temporaryRoot, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    resolve(temporaryRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          noUncheckedIndexedAccess: true,
          baseUrl: repositoryRoot,
          paths: {
            "@stablemates/workhorse": ["typescript/core/src/index.ts"],
          },
        },
        files: typeScriptPaths,
      },
      null,
      2,
    )}\n`,
  );

  const pythonExamples = [
    ...verifiedDocumentationExamples("python"),
    ...Object.entries(landingSnippetLanguages)
      .filter(([, language]) => language === "python")
      .map(([snippet]) => landingSnippets[snippet as LandingSnippetId]),
  ];
  const pythonPaths: string[] = [];
  for (const [index, example] of pythonExamples.entries()) {
    const pythonPath = resolve(temporaryRoot, `example-${index}.py`);
    writeFileSync(pythonPath, `${example}\n`);
    pythonPaths.push(pythonPath);
  }

  writeFileSync(
    resolve(temporaryRoot, "go.mod"),
    `module workhorse-doc-example\n\ngo ${supportManifest.support.go.minimum}\n\nrequire github.com/stablemates/workhorse/go v0.0.0\n\nreplace github.com/stablemates/workhorse/go => ${resolve(repositoryRoot, "go")}\n`,
  );
  const goExamples = [
    ...verifiedDocumentationExamples("go"),
    ...Object.entries(landingSnippetLanguages)
      .filter(([, language]) => language === "go")
      .map(([snippet]) => landingSnippets[snippet as LandingSnippetId]),
  ];
  const goPaths: string[] = [];
  for (const [index, example] of goExamples.entries()) {
    const goPath = resolve(temporaryRoot, `example-${index}.go`);
    writeFileSync(goPath, `${example}\n`);
    const formattingDiff = execFileSync("gofmt", ["-d", goPath], { encoding: "utf8" });
    if (formattingDiff) {
      throw new Error(`Go example ${index} is not gofmt-formatted:\n${formattingDiff}`);
    }
    goPaths.push(goPath);
  }

  await execFileAsync("go", ["mod", "tidy"], { cwd: temporaryRoot });
  await Promise.all([
    execFileAsync("tsc", ["--project", resolve(temporaryRoot, "tsconfig.json")]),
    execFileAsync("uv", [
      "run",
      "--project",
      resolve(repositoryRoot, "python"),
      "ruff",
      "format",
      "--check",
      ...pythonPaths,
    ]),
    execFileAsync("uv", [
      "run",
      "--project",
      resolve(repositoryRoot, "python"),
      "mypy",
      ...pythonPaths,
    ]),
    ...goPaths.map((goPath) =>
      execFileAsync("go", ["test", "-mod=readonly", goPath], { cwd: temporaryRoot }),
    ),
  ]);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
