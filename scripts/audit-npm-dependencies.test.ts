import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Acceptance, collectFindings, findProblems } from "./audit-npm-dependencies.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const report = {
  advisories: {
    "1139427": {
      id: 1139427,
      severity: "high",
      module_name: "nanoid",
      title: "nanoid: custom generators can loop indefinitely when size is zero",
      url: "https://github.com/advisories/GHSA-2v37-7h3g-55p8",
      github_advisory_id: "GHSA-2v37-7h3g-55p8",
      patched_versions: ">=3.3.18",
      findings: [{ version: "3.3.16", paths: ["site>@tanstack/react-start>vite>postcss>nanoid"] }],
    },
  },
};

const acceptance: Acceptance = {
  advisory: 1139427,
  githubAdvisoryId: "GHSA-2v37-7h3g-55p8",
  module: "nanoid",
  workspacePackages: ["site"],
  reason: "Outside the published closure.",
  reviewBy: "2027-03-01",
};

describe("collectFindings", () => {
  it("flattens an advisory into one finding per dependency path", () => {
    const findings = collectFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      advisory: 1139427,
      module: "nanoid",
      version: "3.3.16",
      workspacePackage: "site",
      patchedVersions: ">=3.3.18",
    });
  });
});

describe("findProblems", () => {
  const findings = collectFindings(report);

  it("accepts an advisory reaching a workspace package the entry names", () => {
    expect(findProblems(findings, [acceptance], "2026-09-03")).toEqual([]);
  });

  it("fails on an advisory no entry covers", () => {
    const problems = findProblems(findings, [], "2026-09-03");
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toContain("is not accepted");
  });

  it("fails when an accepted advisory reaches a workspace package the entry does not name", () => {
    const moved = collectFindings({
      advisories: {
        "1139427": {
          ...report.advisories["1139427"],
          findings: [{ version: "3.3.16", paths: ["typescript__core>nanoid"] }],
        },
      },
    });
    const problems = findProblems(moved, [acceptance], "2026-09-03");
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toContain("now reaches typescript__core");
  });

  it("fails once an entry's review date has passed", () => {
    const problems = findProblems(findings, [acceptance], "2027-03-02");
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toContain("due for review");
  });

  it("fails on an entry that matches nothing the audit reports", () => {
    const problems = findProblems([], [acceptance], "2026-09-03");
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toContain("matches nothing");
  });
});

describe("the committed acceptance list", () => {
  it("gives every entry a reason and a review date that has not passed", async () => {
    const file = JSON.parse(
      await readFile(path.join(repositoryRoot, "scripts/npm-advisory-acceptances.json"), "utf8"),
    ) as { acceptances: readonly Acceptance[] };
    const today = new Date().toISOString().slice(0, 10);
    for (const entry of file.acceptances) {
      expect(
        entry.reason.length,
        `advisory ${String(entry.advisory)} states no reason`,
      ).toBeGreaterThan(40);
      expect(entry.workspacePackages.length).toBeGreaterThan(0);
      expect(
        entry.reviewBy >= today,
        `advisory ${String(entry.advisory)} is past its review date ${entry.reviewBy}`,
      ).toBe(true);
    }
  });
});
