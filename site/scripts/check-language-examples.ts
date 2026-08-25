import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const documentationSources = [quickstartSource, examplesSource];
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
        execFileSync("gofmt", [], {
          input: `package guide\n\nfunc example() {\n${unindented}\n}\n`,
          stdio: ["pipe", "ignore", "inherit"],
        });
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

function verifiedDocumentationExamples(language: "python" | "go"): string[] {
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
