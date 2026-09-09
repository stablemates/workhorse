import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Acceptance,
  type AuditReport,
  acceptanceFileName,
  collectFindings,
  describeProblems,
  findProblems,
  findPublishedClosureProblems,
  requireReadableReport,
} from "./audit-npm-dependencies.js";

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

// A security gate that cannot read its input must not report a clean tree. `pnpm audit` answers a
// failed request with a parseable body carrying `error` and no `advisories`, which read as a tree
// is indistinguishable from a healthy one — and with acceptances on file it read as four
// instructions to delete a reviewed decision.
describe("an audit report that never reached the service", () => {
  const timedOut = {
    error: {
      code: "ERR_SOCKET_TIMEOUT",
      message:
        "request to https://registry.npmjs.org/-/npm/v1/security/audits failed, reason: Socket timeout",
    },
  } satisfies AuditReport;

  it("is refused rather than read as a clean tree", () => {
    expect(() => requireReadableReport(timedOut)).toThrowError(/could not read the npm advisory/);
    expect(() => requireReadableReport(timedOut)).toThrowError(/ERR_SOCKET_TIMEOUT/);
    expect(() => requireReadableReport(timedOut)).toThrowError(/Socket timeout/);
  });

  it("does not send the reader to the acceptance list", () => {
    let message = "";
    try {
      requireReadableReport(timedOut);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // The file is named, but as the thing that is *not* stale. The old failure said "Delete the
    // entry from …", which is what deleted a security decision during an outage.
    expect(message).toContain(`no acceptance in ${acceptanceFileName} is stale`);
    expect(message).not.toContain("Delete the entry");
  });

  it("refuses a report carrying neither advisories nor an error", () => {
    expect(() => requireReadableReport({} as AuditReport, "  pnpm exploded  ")).toThrowError(
      /pnpm exploded/,
    );
  });

  it("passes a genuinely clean tree, whose advisories key is present and empty", () => {
    const clean = { advisories: {} } satisfies AuditReport;
    expect(requireReadableReport(clean)).toBe(clean);
    expect(collectFindings(clean)).toEqual([]);
  });

  it("passes a report that carries findings", () => {
    expect(requireReadableReport(report as AuditReport)).toBe(report);
    expect(collectFindings(report as AuditReport).length).toBeGreaterThan(0);
  });
});

// The packed-release gate reads the tree a user installs, and it used to run a bare `pnpm audit`
// whose non-zero exit meant either "this release ships a severe advisory" or "npm never answered".
// A maintainer has to act on those in opposite ways, so the two failures have to read differently.
describe("the packed release gate", () => {
  const published = ["typescript__core", "typescript__dashboard"];
  // `pnpm audit` roots every path at `.` outside a workspace, which is what the consumer is.
  const packedPath = ".>@stablemates/workhorse>nanoid";
  const packed = {
    advisories: {
      "1139427": {
        ...report.advisories["1139427"],
        findings: [{ version: "3.3.16", paths: [packedPath] }],
      },
    },
  } satisfies AuditReport;
  const timedOut = {
    error: {
      code: "ERR_SOCKET_TIMEOUT",
      message:
        "request to https://registry.npmjs.org/-/npm/v1/security/audits failed, reason: Socket timeout",
    },
  } satisfies AuditReport;

  function refusal(): string {
    try {
      requireReadableReport(timedOut);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("An unreadable report was not refused");
  }

  it("fails on a severe advisory in the packed tree, naming the advisory and the acceptance file", () => {
    const problems = findPublishedClosureProblems(collectFindings(packed), [], published);
    expect(problems).toHaveLength(1);
    const message = describeProblems(problems);
    expect(message).toContain("1139427");
    expect(message).toContain("nanoid@3.3.16");
    expect(message).toContain(acceptanceFileName);
    expect(message).toContain(packedPath);
  });

  it("fails differently when the advisory service never answered", () => {
    const message = refusal();
    expect(message).toContain("could not read the npm advisory service");
    expect(message).toContain("ERR_SOCKET_TIMEOUT");
    // Naming no advisory is the point: none was reported, and none was ruled out either.
    expect(message).not.toContain("1139427");
    expect(message).not.toContain("reaches the packed release tree");
  });

  it("refuses an unreachable service in the same words as pnpm npm:vuln", () => {
    expect(refusal()).toContain(`no acceptance in ${acceptanceFileName} is stale`);
  });

  it("passes an advisory an entry accepts for a published package", () => {
    const entry: Acceptance = { ...acceptance, workspacePackages: ["typescript__core"] };
    expect(findPublishedClosureProblems(collectFindings(packed), [entry], published)).toEqual([]);
  });

  it("fails an advisory accepted only outside the published closure", () => {
    // `site` is not published, so the entry's stated reason — outside the published closure — is
    // contradicted by the finding: the packed tree is the published closure.
    const problems = findPublishedClosureProblems(collectFindings(packed), [acceptance], published);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toContain("reaches the packed release tree");
  });

  it("leaves a moderate advisory to pnpm npm:vuln", () => {
    const moderate = collectFindings({
      advisories: {
        "1139427": {
          ...packed.advisories["1139427"],
          severity: "moderate",
        },
      },
    });
    expect(findPublishedClosureProblems(moderate, [], published)).toEqual([]);
    expect(findProblems(moderate, [], "2026-09-09")).toHaveLength(1);
  });

  it("passes a packed tree with no advisory at all", () => {
    const clean = { advisories: {} } satisfies AuditReport;
    expect(findPublishedClosureProblems(collectFindings(clean), [], published)).toEqual([]);
  });
});
