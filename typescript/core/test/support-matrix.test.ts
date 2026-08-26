import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  describePostgresSupport,
  MINIMUM_NODE_MAJOR,
  MINIMUM_POSTGRES_MAJOR,
  SMOKE_TESTED_JS_RUNTIMES,
  SUPPORTED_NODE_MAJORS,
  SUPPORTED_POSTGRES_MAJORS,
} from "../src/support.js";
import { publishedPackages } from "../../../scripts/packages.js";
import { buildCiMatrices } from "../../../scripts/ci-matrix.js";

// A supported-version contract is only worth stating if the statement and the thing that tests it
// cannot drift apart. support.json is the source of truth; everything below is a consumer of it,
// and this file is what makes adding a version in one place and forgetting the others a failure.

const repository = path.resolve(import.meta.dirname, "../../..");
// Which manifests are published is owned by scripts/packages.ts, so adding a package brings it
// under the engines and provenance checks below without an edit here.
const publishedManifests = (await publishedPackages()).map((entry) => entry.manifest);

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repository, relativePath), "utf8");
}

async function readManifest(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(relativePath)) as Record<string, unknown>;
}

interface SupportManifest {
  readonly support: {
    readonly go: { readonly minimum: string };
    readonly node: { readonly minimum: number; readonly tested: number[] };
    readonly postgres: { readonly minimum: number; readonly tested: number[] };
    readonly python: { readonly minimum: string; readonly tested: string[] };
  };
  readonly toolchains: {
    readonly go: string;
    readonly node: string;
    readonly pnpm: string;
    readonly uv: string;
  };
}

async function readSupportManifest(): Promise<SupportManifest> {
  return JSON.parse(await read("support.json")) as SupportManifest;
}

function markdownTable(source: string, heading: string): Record<string, Record<string, string>> {
  const tableSource = source.slice(source.indexOf(heading) + heading.length).trimStart();
  const lines: string[] = [];
  for (const line of tableSource.split("\n")) {
    if (!line.startsWith("|")) break;
    lines.push(line);
  }
  const cells = lines.map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
  const [headers, , ...rows] = cells;
  if (!headers) throw new Error(`${heading} has no Markdown table`);
  return Object.fromEntries(
    rows.map((row) => [
      row[0]!,
      Object.fromEntries(headers.map((header, index) => [header, row[index]!])),
    ]),
  );
}

describe("supported version constants", () => {
  it("matches the repository support manifest", async () => {
    const manifest = await readSupportManifest();

    expect(manifest.support.node).toEqual({
      minimum: MINIMUM_NODE_MAJOR,
      tested: SUPPORTED_NODE_MAJORS,
    });
    expect(manifest.support.postgres).toEqual({
      minimum: MINIMUM_POSTGRES_MAJOR,
      tested: SUPPORTED_POSTGRES_MAJORS,
    });
  });

  it("keeps local toolchains on the declared support floor", async () => {
    const [manifest, miseSource] = await Promise.all([readSupportManifest(), read("mise.toml")]);
    const mise = parseToml(miseSource) as { tools: Record<string, string> };

    expect(mise.tools).toEqual({
      go: manifest.toolchains.go,
      node: manifest.toolchains.node,
      pnpm: manifest.toolchains.pnpm,
      python: manifest.support.python.minimum,
      uv: manifest.toolchains.uv,
    });
    expect(
      manifest.toolchains.go.startsWith(manifest.support.go.minimum.replace(/\.0$/, ".")),
    ).toBe(true);
  });

  it("matches the Go and Python package manifests", async () => {
    const [manifest, goMod, pythonSource] = await Promise.all([
      readSupportManifest(),
      read("go/go.mod"),
      read("python/pyproject.toml"),
    ]);
    const goDirectives = Object.fromEntries(
      goMod
        .split("\n")
        .map((line) => line.trim().split(/\s+/, 2))
        .filter(([directive]) => directive === "go" || directive === "toolchain"),
    );
    const python = parseToml(pythonSource) as {
      project: { classifiers: string[]; "requires-python": string };
      tool: { mypy: { python_version: string }; ruff: { "target-version": string } };
    };
    const pythonClassifierPrefix = "Programming Language :: Python :: ";
    const pythonClassifiers = python.project.classifiers
      .filter((classifier) => /^Programming Language :: Python :: 3\.\d+$/.test(classifier))
      .map((classifier) => classifier.slice(pythonClassifierPrefix.length));

    expect(goDirectives).toEqual({
      go: manifest.support.go.minimum,
      toolchain: `go${manifest.toolchains.go}`,
    });
    expect(python.project["requires-python"]).toBe(`>=${manifest.support.python.minimum}`);
    expect(pythonClassifiers).toEqual(manifest.support.python.tested);
    expect(python.tool.mypy.python_version).toBe(manifest.support.python.minimum);
    expect(python.tool.ruff["target-version"]).toBe(
      `py${manifest.support.python.minimum.replace(".", "")}`,
    );
  });

  it("keeps each list sorted, non-empty, and anchored at its minimum", () => {
    expect(SUPPORTED_NODE_MAJORS.length).toBeGreaterThan(0);
    expect(SUPPORTED_POSTGRES_MAJORS.length).toBeGreaterThan(0);
    // Ascending order is what makes `[0]` the minimum and `.at(-1)` the newest tested major, which
    // both this file and the documentation rely on.
    for (const list of [SUPPORTED_NODE_MAJORS, SUPPORTED_POSTGRES_MAJORS]) {
      for (let index = 1; index < list.length; index += 1) {
        expect(list[index]!).toBeGreaterThan(list[index - 1]!);
      }
    }
    expect(SUPPORTED_NODE_MAJORS[0]).toBe(MINIMUM_NODE_MAJOR);
    expect(SUPPORTED_POSTGRES_MAJORS[0]).toBe(MINIMUM_POSTGRES_MAJOR);
  });

  it("only claims even-numbered Node.js releases, which are the ones with long-term support", () => {
    for (const major of SUPPORTED_NODE_MAJORS) expect(major % 2).toBe(0);
  });
});

describe("declared engines", () => {
  it.each(publishedManifests)(
    "%s requires the minimum supported Node.js major",
    async (manifest) => {
      const parsed = await readManifest(manifest);
      const engines = parsed.engines as { node?: string } | undefined;
      expect(engines?.node).toBe(`>=${MINIMUM_NODE_MAJOR}`);
    },
  );

  it.each(publishedManifests)(
    "%s carries the metadata npm provenance requires",
    async (manifest) => {
      const parsed = await readManifest(manifest);
      const repositoryField = parsed.repository as { url?: string } | undefined;
      const publishConfig = parsed.publishConfig as
        | { access?: string; provenance?: boolean }
        | undefined;
      expect(repositoryField?.url).toContain("github.com/stablemates/workhorse");
      expect(publishConfig?.provenance).toBe(true);
      expect(publishConfig?.access).toBe("public");
    },
  );

  it("versions every published package in lockstep", async () => {
    const versions = await Promise.all(
      publishedManifests.map(async (manifest) => (await readManifest(manifest)).version),
    );
    expect(new Set(versions).size).toBe(1);
  });
});

describe("continuous integration", () => {
  it("uses boundary pairs on pull requests and the full support matrix elsewhere", async () => {
    const manifest = await readSupportManifest();
    const pullRequest = buildCiMatrices(manifest.support, "pull_request");
    const full = buildCiMatrices(manifest.support, "push");

    expect(pullRequest.typescript.include).toEqual([
      { node: 22, postgres: 15 },
      { node: 24, postgres: 18 },
    ]);
    expect(pullRequest.python.include).toEqual([
      { python: "3.10", postgres: 15 },
      { python: "3.14", postgres: 18 },
    ]);
    expect(pullRequest.go.include).toEqual([{ go: "1.25", postgres: 18 }]);
    expect(pullRequest.packed.include).toEqual([{ node: 22 }]);

    expect(full.typescript.include).toHaveLength(
      manifest.support.node.tested.length * manifest.support.postgres.tested.length,
    );
    expect(full.python.include).toHaveLength(
      manifest.support.python.tested.length * manifest.support.postgres.tested.length,
    );
    expect(full.go.include).toHaveLength(manifest.support.postgres.tested.length);
    expect(full.packed.include).toEqual([{ node: 22 }, { node: 24 }]);
    for (const node of manifest.support.node.tested) {
      for (const postgres of manifest.support.postgres.tested) {
        expect(full.typescript.include).toContainEqual({ node, postgres });
      }
    }
    for (const python of manifest.support.python.tested) {
      for (const postgres of manifest.support.postgres.tested) {
        expect(full.python.include).toContainEqual({ python, postgres });
      }
    }
    for (const postgres of manifest.support.postgres.tested) {
      expect(full.go.include).toContainEqual({ go: "1.25", postgres });
    }
  });

  it("exposes one stable required check without granting pull requests write access", async () => {
    const workflow = await read(".github/workflows/ci.yml");

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("name: required");
    expect(workflow).toContain(
      "needs: [static, unit, typescript, python, go, runtime-smoke, packed, demo]",
    );
    expect(workflow).toContain("pnpm --silent exec tsx scripts/ci-matrix.ts");
    expect(workflow).toContain("pnpm go:test:race");
  });

  it("exposes each language check through structured package scripts", async () => {
    const scripts = (await readManifest("package.json")).scripts as Record<string, string>;

    expect(scripts["python:test"]).toContain("pytest python/tests");
    expect(scripts["python:vuln"]).toContain("audit-python-dependencies.sh");
    expect(scripts["go:test"]).toContain("go -C go test ./...");
    expect(scripts["go:test:race"]).toContain("go -C go test -race ./...");
    expect(scripts["go:vuln"]).toContain("govulncheck");
    expect(scripts.check).toContain("pnpm python:vuln");
    expect(scripts.check).toContain("pnpm go:vuln");
    expect(scripts.check).toContain("pnpm go:test:race");
  });

  it("smoke-tests exactly the declared JS runtimes without claiming them as supported", async () => {
    const workflow = await read(".github/workflows/ci.yml");

    // The lane exercises the round-trip script per runtime; the runtime list in the workflow
    // matrix and the exported constant must agree, or the documentation claims an untested lane.
    expect(workflow).toContain(`runtime: [${SMOKE_TESTED_JS_RUNTIMES.join(", ")}]`);
    expect(workflow).toContain("pnpm test:runtime-smoke:${{ matrix.runtime }}");

    const scripts = (await readManifest("package.json")).scripts as Record<string, string>;
    for (const runtime of SMOKE_TESTED_JS_RUNTIMES) {
      const script = scripts[`test:runtime-smoke:${runtime}`];
      expect(script).toContain(runtime);
      expect(script).toContain("typescript/core/test/runtime-smoke.ts");
    }
  });

  it("publishes with provenance from a workflow that can mint an identity token", async () => {
    const workflow = await read(".github/workflows/release.yml");
    expect(workflow).toContain("needs: build");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("actions/download-artifact");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm publish --provenance");
  });

  it("publishes Python distributions from a checked, versioned tag", async () => {
    const workflow = await read(".github/workflows/release-python.yml");

    expect(workflow).toContain('tags: ["python/v*"]');
    expect(workflow).toContain("pnpm release:check python $GITHUB_REF_NAME");
    expect(workflow).toContain("pnpm db:reset:test-packed");
    expect(workflow).toContain("pnpm check");
    expect(workflow).toContain("uv build --project python");
    expect(workflow).toContain("needs: build");
    expect(workflow).toContain("environment: pypi");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("uv publish --trusted-publishing always");
  });

  it("creates Go module tags only after the release check and full repository gate", async () => {
    const script = await read("scripts/release-go.sh");

    expect(script.indexOf('pnpm release:check go "$tag"')).toBeLessThan(
      script.indexOf("pnpm check"),
    );
    expect(script.indexOf("pnpm check")).toBeLessThan(script.indexOf('git tag --annotate "$tag"'));
    expect(script).toContain("pnpm db:reset:test");
    expect(script).toContain("pnpm db:reset:test-packed");
    expect(script).toContain("git diff --quiet");
    expect(script).toContain('git push origin "$tag"');
  });

  it("installs the non-Node toolchains before static and release checks", async () => {
    for (const workflowPath of [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      ".github/workflows/release-python.yml",
    ]) {
      const workflow = await read(workflowPath);
      expect(workflow).toContain("actions/setup-go@v7");
      expect(workflow).toContain("go-version-file: go/go.mod");
      expect(workflow).toContain("astral-sh/setup-uv@v9");
    }
  });

  it("benchmarks main on a supported PostgreSQL major under an explicit timeout", async () => {
    const workflow = await read(".github/workflows/benchmark.yml");

    // Without a ceiling a hung scenario occupies a runner for GitHub's six-hour default, so the
    // timeout is part of the contract rather than a tuning detail.
    expect(workflow).toMatch(/^\s*timeout-minutes: \d+$/m);
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("--profile smoke");
    expect(workflow).toContain("--output");
    expect(workflow).toContain("actions/upload-artifact");

    const image = /image: postgres:(\d+)-alpine/.exec(workflow);
    expect(SUPPORTED_POSTGRES_MAJORS).toContain(Number(image?.[1]));
  });
});

describe("documentation", () => {
  it("keeps the exact matrix in the reference and links guides to it", async () => {
    const [compatibility, sitePage, installation, readme, goReadme, pythonReadme, goMod, manifest] =
      await Promise.all([
        read("docs/compatibility.md"),
        read("site/content/docs/compatibility.mdx"),
        read("site/content/docs/installation.mdx"),
        read("README.md"),
        read("go/README.md"),
        read("python/README.md"),
        read("go/go.mod"),
        readSupportManifest(),
      ]);
    const claimed = `${SUPPORTED_POSTGRES_MAJORS.join(", ")}`;
    const claimedNodeMajors = SUPPORTED_NODE_MAJORS.join(", ");
    const supportTable = markdownTable(compatibility, "## Supported versions");
    const goMinimum = manifest.support.go.minimum.replace(/\.0$/, "");
    const pythonTested = manifest.support.python.tested;
    const pgxVersion = goMod
      .split("\n")
      .find((line) => line.startsWith("require github.com/jackc/pgx/v5 "))
      ?.split(" ")
      .at(-1);
    const normalizedPythonReadme = pythonReadme.replace(/\s+/g, " ");

    expect(supportTable["Node.js"]).toMatchObject({
      Supported: claimedNodeMajors,
      Minimum: String(manifest.support.node.minimum),
    });
    expect(supportTable.Python).toMatchObject({
      Supported: `${pythonTested[0]}–${pythonTested.at(-1)}`,
      Minimum: manifest.support.python.minimum,
    });
    expect(supportTable.Go).toMatchObject({
      Supported: `${goMinimum} and newer`,
      Minimum: goMinimum,
    });
    expect(supportTable.PostgreSQL).toMatchObject({
      Supported: claimed,
      Minimum: String(manifest.support.postgres.minimum),
    });
    expect(goReadme).toContain(`Go ${goMinimum} or newer`);
    expect(goReadme).toContain(`PostgreSQL ${claimed}`);
    expect(goReadme).toContain(`pgx ${pgxVersion}`);
    expect(goReadme).toContain("## Deployment and delivery boundaries");
    expect(goReadme).toContain("Delivery is at least once.");
    expect(goReadme).toContain("## Releasing the module");
    expect(goReadme).toContain("go/vX.Y.Z");
    expect(pythonReadme).toContain(
      `Python ${pythonTested[0]} through ${pythonTested.at(-1)} and PostgreSQL ${claimed}`,
    );
    expect(normalizedPythonReadme).toContain("Psycopg 3.3 through the next major");
    expect(normalizedPythonReadme).toContain("asyncpg 0.31 through the next major");
    expect(pythonReadme).toContain("pip install stablemates-workhorse");
    expect(pythonReadme).toContain("run_worker_process(worker)");
    expect(pythonReadme).toContain('workhorse dashboard --database-url "$DATABASE_URL"');
    expect(sitePage).toContain(
      "https://github.com/stablemates/workhorse/blob/main/docs/compatibility.md",
    );
    expect(sitePage).not.toContain(claimed);
    expect(sitePage).not.toContain(claimedNodeMajors);
    expect(installation).toContain("[Compatibility](/docs/compatibility)");
    // The smoke tier is a weaker claim than support, and both layers must state it as such: the
    // reference names each runtime's tier section, and the site page describes it without pinning
    // versions it does not test.
    for (const runtime of SMOKE_TESTED_JS_RUNTIMES) {
      expect(compatibility.toLowerCase()).toContain(runtime);
      expect(sitePage.toLowerCase()).toContain(runtime);
    }
    expect(compatibility).toContain("## JS runtime smoke tier");
    expect(sitePage).toContain("smoke-tested tier, not support");
    expect(readme).toContain(`PostgreSQL **${MINIMUM_POSTGRES_MAJOR} or newer**`);
    expect(readme).toContain(`Node.js **>= ${MINIMUM_NODE_MAJOR}**`);
    expect(readme).toContain("mise install");
  });

  it("documents the released version in the changelog", async () => {
    const [changelog, manifest] = await Promise.all([
      read("CHANGELOG.md"),
      readManifest("typescript/core/package.json"),
    ]);
    expect(changelog).toContain(`## ${String(manifest.version)} `);
  });
});

describe("describePostgresSupport", () => {
  it("decodes a server_version_num into its major", () => {
    expect(describePostgresSupport(150_004, "15.4").major).toBe(15);
    expect(describePostgresSupport(180_000, "18.0").major).toBe(18);
  });

  it("rejects a server below the minimum", () => {
    const support = describePostgresSupport((MINIMUM_POSTGRES_MAJOR - 1) * 10_000, "old");
    expect(support.supported).toBe(false);
    expect(support.tested).toBe(false);
  });

  it("accepts a server newer than the tested set without claiming coverage", () => {
    const newest = SUPPORTED_POSTGRES_MAJORS.at(-1)!;
    const support = describePostgresSupport((newest + 1) * 10_000, "future");
    expect(support.supported).toBe(true);
    expect(support.tested).toBe(false);
  });

  it("reports a tested major as covered", () => {
    for (const major of SUPPORTED_POSTGRES_MAJORS) {
      const support = describePostgresSupport(major * 10_000 + 3, `${major}.3`);
      expect(support).toMatchObject({ major, supported: true, tested: true });
    }
  });
});
