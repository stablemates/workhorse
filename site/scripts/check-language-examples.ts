import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  landingFeatureSnippets,
  landingSnippetLanguages,
  landingSnippets,
  landingSupplementalSnippets,
} from "../lib/landing-snippets.js";
import type { LandingSnippetId } from "../lib/landing-snippets.js";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(siteRoot, "..");
const quickstartSource = readFileSync(resolve(siteRoot, "content/docs/quickstart.mdx"), "utf8");
const examplesSource = readFileSync(resolve(siteRoot, "content/docs/examples.mdx"), "utf8");
const documentationSources = [quickstartSource, examplesSource];

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
  // Native Python and Go policy APIs are tracked by WH-367 and WH-366; WH-369 removes this exception.
  if (name === "flowControl") continue;
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
  for (const [index, example] of pythonExamples.entries()) {
    const pythonPath = resolve(temporaryRoot, `example-${index}.py`);
    writeFileSync(pythonPath, `${example}\n`);
    execFileSync(
      "uv",
      [
        "run",
        "--project",
        resolve(repositoryRoot, "python"),
        "ruff",
        "format",
        "--check",
        pythonPath,
      ],
      { stdio: "inherit" },
    );
    execFileSync(
      "uv",
      ["run", "--project", resolve(repositoryRoot, "python"), "mypy", pythonPath],
      { stdio: "inherit" },
    );
  }

  writeFileSync(
    resolve(temporaryRoot, "go.mod"),
    `module workhorse-doc-example\n\ngo 1.23\n\nrequire github.com/stablemates/workhorse/go v0.0.0\n\nreplace github.com/stablemates/workhorse/go => ${resolve(repositoryRoot, "go")}\n`,
  );
  const goExamples = [
    ...verifiedDocumentationExamples("go"),
    ...Object.entries(landingSnippetLanguages)
      .filter(([, language]) => language === "go")
      .map(([snippet]) => landingSnippets[snippet as LandingSnippetId]),
  ];
  for (const [index, example] of goExamples.entries()) {
    const goPath = resolve(temporaryRoot, `example-${index}.go`);
    writeFileSync(goPath, `${example}\n`);
    const formattingDiff = execFileSync("gofmt", ["-d", goPath], { encoding: "utf8" });
    if (formattingDiff) {
      throw new Error(`Go example ${index} is not gofmt-formatted:\n${formattingDiff}`);
    }
    execFileSync("go", ["test", "-mod=mod", goPath], { cwd: temporaryRoot, stdio: "inherit" });
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
