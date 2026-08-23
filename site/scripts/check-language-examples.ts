import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(siteRoot, "..");
const documentationSources = ["quickstart.mdx", "examples.mdx"].map((name) =>
  readFileSync(resolve(siteRoot, "content/docs", name), "utf8"),
);

function verifiedExamples(language: "python" | "go"): string[] {
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
  for (const [index, example] of verifiedExamples("python").entries()) {
    const pythonPath = resolve(temporaryRoot, `example-${index}.py`);
    writeFileSync(pythonPath, example);
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
  for (const [index, example] of verifiedExamples("go").entries()) {
    const goPath = resolve(temporaryRoot, `example-${index}.go`);
    writeFileSync(goPath, example);
    execFileSync("go", ["test", "-mod=mod", goPath], { cwd: temporaryRoot, stdio: "inherit" });
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
