import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  describePostgresSupport,
  MINIMUM_NODE_MAJOR,
  MINIMUM_POSTGRES_MAJOR,
  SUPPORTED_NODE_MAJORS,
  SUPPORTED_POSTGRES_MAJORS,
} from "../src/support.js";
import { publishedPackages } from "../../../scripts/packages.js";

// A supported-version contract is only worth stating if the statement and the thing that tests it
// cannot drift apart. src/support.ts is the source of truth; everything below is a consumer of it,
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

/** Read a `key: [1, 2]` matrix list out of the workflow without taking a YAML dependency. */
function workflowMatrixList(workflow: string, key: string): number[][] {
  const matches = [...workflow.matchAll(new RegExp(`^\\s*${key}: \\[([^\\]]*)\\]`, "gm"))];
  return matches.map((match) => match[1]!.split(",").map((entry) => Number(entry.trim())));
}

describe("supported version constants", () => {
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
  it("tests exactly the supported Node.js and PostgreSQL majors", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    const nodeLists = workflowMatrixList(workflow, "node");
    const postgresLists = workflowMatrixList(workflow, "postgres");

    // The full suite runs the whole grid; narrower jobs may test a subset of Node majors, but no
    // job may claim a version that is not supported.
    expect(nodeLists).toContainEqual([...SUPPORTED_NODE_MAJORS]);
    expect(postgresLists).toContainEqual([...SUPPORTED_POSTGRES_MAJORS]);
    for (const list of nodeLists) {
      for (const major of list) expect(SUPPORTED_NODE_MAJORS).toContain(major);
    }
    for (const list of postgresLists) {
      for (const major of list) expect(SUPPORTED_POSTGRES_MAJORS).toContain(major);
    }
  });

  it("publishes with provenance from a workflow that can mint an identity token", async () => {
    const workflow = await read(".github/workflows/release.yml");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm publish --provenance");
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
    const [compatibility, sitePage, installation, readme] = await Promise.all([
      read("docs/compatibility.md"),
      read("site/content/docs/compatibility.mdx"),
      read("site/content/docs/installation.mdx"),
      read("README.md"),
    ]);
    const claimed = `${SUPPORTED_POSTGRES_MAJORS.join(", ")}`;
    const claimedNodeMajors = SUPPORTED_NODE_MAJORS.join(", ");

    expect(compatibility).toContain(claimed);
    expect(compatibility).toContain(claimedNodeMajors);
    expect(sitePage).toContain(
      "https://github.com/stablemates/workhorse/blob/main/docs/compatibility.md",
    );
    expect(sitePage).not.toContain(claimed);
    expect(sitePage).not.toContain(claimedNodeMajors);
    expect(installation).toContain("[Compatibility](/docs/compatibility)");
    expect(readme).toContain(`PostgreSQL **${MINIMUM_POSTGRES_MAJOR} or newer**`);
    expect(readme).toContain(`Node.js **>= ${MINIMUM_NODE_MAJOR}**`);
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
