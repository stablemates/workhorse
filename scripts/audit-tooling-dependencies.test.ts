import { describe, expect, it } from "vitest";
import { type Acceptance, type AuditReport, collectFindings } from "./audit-npm-dependencies.js";
import {
  type PipAuditReport,
  type PythonAcceptance,
  type ToolingAcceptances,
  type ToolingScan,
  collectPythonFindings,
  findToolingProblems,
  requireReadablePipAuditReport,
  toolingAcceptanceFileName,
} from "./audit-tooling-dependencies.js";

const today = "2026-09-30";

// An advisory that reaches the workspace only through a development dependency of the root.
const devOnlyReport: AuditReport = {
  advisories: {
    "1200001": {
      id: 1200001,
      severity: "high",
      module_name: "esbuild",
      title: "esbuild: development server answers any origin",
      url: "https://github.com/advisories/GHSA-test-only-0001",
      github_advisory_id: "GHSA-test-only-0001",
      patched_versions: ">=0.99.0",
      findings: [{ version: "0.25.0", paths: [".>vite>esbuild"] }],
    },
  },
};

// An advisory that the production gate reports, through a published package.
const productionReport: AuditReport = {
  advisories: {
    "1200002": {
      id: 1200002,
      severity: "moderate",
      module_name: "pg-protocol",
      title: "pg-protocol: oversized message",
      url: "https://github.com/advisories/GHSA-test-prod-0002",
      github_advisory_id: "GHSA-test-prod-0002",
      patched_versions: ">=9.9.9",
      findings: [{ version: "1.0.0", paths: ["typescript__core>pg>pg-protocol"] }],
    },
  },
};

const devAcceptance: Acceptance = {
  advisory: 1200001,
  githubAdvisoryId: "GHSA-test-only-0001",
  module: "esbuild",
  workspacePackages: ["."],
  reason: "The development server never runs in CI or in a release job.",
  reviewBy: "2026-12-31",
};

const productionAcceptance: Acceptance = {
  advisory: 1200002,
  githubAdvisoryId: "GHSA-test-prod-0002",
  module: "pg-protocol",
  workspacePackages: ["typescript__core"],
  reason: "Trying to answer a production finding from the tooling list.",
  reviewBy: "2026-12-31",
};

const pythonTooling: PipAuditReport = {
  dependencies: [
    { name: "hatchling", version: "1.27.0", vulns: [] },
    {
      name: "mypy",
      version: "1.0.0",
      vulns: [{ id: "PYSEC-TEST-1", aliases: ["CVE-TEST-1"], fix_versions: ["1.1.0"] }],
    },
    {
      name: "psycopg",
      version: "3.0.0",
      vulns: [{ id: "GHSA-test-py-prod", aliases: ["CVE-TEST-2"], fix_versions: ["3.3.0"] }],
    },
  ],
};

const pythonProduction: PipAuditReport = {
  dependencies: [
    {
      name: "psycopg",
      version: "3.0.0",
      vulns: [{ id: "GHSA-test-py-prod", aliases: ["CVE-TEST-2"], fix_versions: ["3.3.0"] }],
    },
  ],
};

const mypyAcceptance: PythonAcceptance = {
  id: "PYSEC-TEST-1",
  package: "mypy",
  reason: "Type checking reads only repository sources.",
  reviewBy: "2026-12-31",
};

const empty: ToolingAcceptances = { npm: [], python: [] };

function scan(overrides: Partial<ToolingScan> = {}): ToolingScan {
  return { npmAll: [], npmProduction: [], pythonAll: [], pythonProduction: [], ...overrides };
}

function headlines(acceptances: ToolingAcceptances, input: ToolingScan): readonly string[] {
  return findToolingProblems(input, acceptances, today).map((problem) => problem.headline);
}

describe("the npm half of the tooling lane", () => {
  it("fails on an advisory present only in a development dependency", () => {
    const input = scan({ npmAll: collectFindings(devOnlyReport) });
    expect(headlines(empty, input)).toEqual([
      `Advisory 1200001 in esbuild is not accepted in ${toolingAcceptanceFileName}`,
    ]);
  });

  it("lets an accepted development advisory pass", () => {
    const input = scan({ npmAll: collectFindings(devOnlyReport) });
    expect(headlines({ npm: [devAcceptance], python: [] }, input)).toEqual([]);
  });

  it("leaves an advisory the production gate reports to that gate", () => {
    const production = collectFindings(productionReport);
    const input = scan({ npmAll: production, npmProduction: production });
    expect(headlines(empty, input)).toEqual([]);
  });

  it("refuses a tooling acceptance that names a production advisory", () => {
    const production = collectFindings(productionReport);
    const input = scan({ npmAll: production, npmProduction: production });
    expect(headlines({ npm: [productionAcceptance], python: [] }, input)).toEqual([
      `${toolingAcceptanceFileName} accepts npm advisory 1200002, which the production gate reports`,
    ]);
  });

  it("fails on an overdue or unmatched entry", () => {
    const overdue = { ...devAcceptance, reviewBy: "2026-09-01" };
    expect(
      headlines({ npm: [overdue], python: [] }, scan({ npmAll: collectFindings(devOnlyReport) })),
    ).toEqual(["Acceptance of advisory 1200001 was due for review on 2026-09-01"]);
    expect(headlines({ npm: [devAcceptance], python: [] }, scan())).toEqual([
      "Acceptance of advisory 1200001 matches nothing pnpm audit reports",
    ]);
  });
});

describe("the Python half of the tooling lane", () => {
  const all = collectPythonFindings(pythonTooling);
  const production = collectPythonFindings(pythonProduction);

  it("fails on an advisory present only in the development or build tooling", () => {
    expect(headlines(empty, scan({ pythonAll: all, pythonProduction: production }))).toEqual([
      `Advisory PYSEC-TEST-1 in mypy is not accepted in ${toolingAcceptanceFileName}`,
    ]);
  });

  it("lets an accepted tooling advisory pass, matched by id or alias", () => {
    const input = scan({ pythonAll: all, pythonProduction: production });
    expect(headlines({ npm: [], python: [mypyAcceptance] }, input)).toEqual([]);
    const byAlias = { ...mypyAcceptance, id: "CVE-TEST-1" };
    expect(headlines({ npm: [], python: [byAlias] }, input)).toEqual([]);
  });

  it("refuses an entry that names a production advisory by any of its identifiers", () => {
    const claim: PythonAcceptance = { ...mypyAcceptance, id: "CVE-TEST-2", package: "psycopg" };
    const input = scan({ pythonAll: all, pythonProduction: production });
    expect(headlines({ npm: [], python: [mypyAcceptance, claim] }, input)).toEqual([
      `${toolingAcceptanceFileName} accepts Python advisory CVE-TEST-2, which the production gate reports`,
    ]);
  });

  it("fails on an overdue or unmatched entry", () => {
    const overdue = { ...mypyAcceptance, reviewBy: "2026-09-01" };
    expect(headlines({ npm: [], python: [overdue] }, scan({ pythonAll: all }))).toEqual([
      "Advisory GHSA-test-py-prod in psycopg is not accepted in scripts/tooling-advisory-acceptances.json",
      "Acceptance of advisory PYSEC-TEST-1 was due for review on 2026-09-01",
    ]);
    expect(headlines({ npm: [], python: [mypyAcceptance] }, scan())).toEqual([
      "Acceptance of advisory PYSEC-TEST-1 matches nothing pip-audit reports",
    ]);
  });
});

describe("collectPythonFindings across the development export and the build backend", () => {
  it("keeps both versions of a distribution the two environments pin differently", () => {
    const development: PipAuditReport = {
      dependencies: [
        { name: "packaging", version: "24.0", vulns: [{ id: "PYSEC-TEST-OLD" }] },
        { name: "mypy", version: "1.0.0", vulns: [{ id: "PYSEC-TEST-1" }] },
      ],
    };
    const backend: PipAuditReport = {
      dependencies: [
        { name: "packaging", version: "26.3", vulns: [{ id: "PYSEC-TEST-NEW" }] },
        { name: "mypy", version: "1.0.0", vulns: [{ id: "PYSEC-TEST-1" }] },
      ],
    };
    const findings = collectPythonFindings(development, backend);
    expect(
      findings.map((finding) => `${finding.package}@${finding.version} ${finding.id}`),
    ).toEqual([
      "mypy@1.0.0 PYSEC-TEST-1",
      "packaging@26.3 PYSEC-TEST-NEW",
      "packaging@24.0 PYSEC-TEST-OLD",
    ]);
  });
});

describe("tooling acceptance entries", () => {
  it.each([
    ["no reason", { reason: " " }],
    ["a date that is not on the calendar", { reviewBy: "2026-02-30" }],
    ["a date in another format", { reviewBy: "31/12/2026" }],
  ])("fail with %s", (_label, change) => {
    const entry = { ...mypyAcceptance, ...change };
    expect(headlines({ npm: [], python: [entry] }, scan())).toEqual([
      "Acceptance of Python advisory PYSEC-TEST-1 needs a reason and a reviewBy calendar date",
    ]);
  });
});

describe("requireReadablePipAuditReport", () => {
  it("returns a completed scan even when pip-audit exits non-zero", () => {
    const output = JSON.stringify(pythonTooling);
    expect(requireReadablePipAuditReport(output, "Found 2 known vulnerabilities")).toEqual(
      pythonTooling,
    );
  });

  it("refuses a dependency pip-audit skipped instead of reading it as clean", () => {
    const output = JSON.stringify({
      dependencies: [
        { name: "mypy", version: "1.0.0", vulns: [] },
        { name: "hatchling", skip_reason: "Dependency not found on PyPI and could not be audited" },
      ],
    });
    expect(() => requireReadablePipAuditReport(output, "")).toThrow(
      "pip-audit skipped dependencies it could not audit: hatchling (Dependency not found on PyPI and could not be audited).",
    );
  });

  it("refuses output that describes no scan", () => {
    expect(() => requireReadablePipAuditReport("", "ConnectionError: pypi.org")).toThrow(
      `pip-audit did not complete a scan: ConnectionError: pypi.org. No decision was made about any dependency, and no acceptance in ${toolingAcceptanceFileName} is stale.`,
    );
  });
});
