import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Acceptance,
  type DenyRecord,
  acceptanceFileName,
  collectFindings,
  describeProblems,
  findProblems,
  findUnexplainedErrors,
  parseDenyOutput,
  requireReadableReport,
} from "./audit-rust-dependencies.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// Trimmed from a real `cargo deny --format json check advisories` run against a database seeded
// with one advisory for ahash, which the crate reaches through jsonschema.
const advisoryLine = JSON.stringify({
  fields: {
    advisory: {
      id: "RUSTSEC-2099-0001",
      package: "ahash",
      title: "Seeded advisory for SM-895 verification",
    },
    code: "vulnerability",
    graphs: [
      {
        Krate: { name: "ahash", version: "0.8.12" },
        parents: [
          {
            Krate: { name: "jsonschema", version: "0.57.0" },
            parents: [{ Krate: { name: "workhorse", version: "0.4.0" } }],
          },
          {
            Krate: { name: "referencing", version: "0.57.0" },
            parents: [{ Krate: { name: "jsonschema", version: "0.57.0" }, repeat: true }],
          },
        ],
      },
    ],
    message: "Seeded advisory for SM-895 verification",
    notes: [
      "ID: RUSTSEC-2099-0001",
      "Advisory: https://rustsec.org/advisories/RUSTSEC-2099-0001",
      "Solution: Upgrade to >=0.8.99 (try `cargo update -p ahash`)",
    ],
    severity: "error",
  },
  type: "diagnostic",
});
const failingSummary = JSON.stringify({
  fields: { advisories: { errors: 1, helps: 0, notes: 0, warnings: 0 } },
  type: "summary",
});
const cleanSummary = JSON.stringify({
  fields: { advisories: { errors: 0, helps: 0, notes: 0, warnings: 0 } },
  type: "summary",
});
// What cargo-deny writes when it cannot reach the advisory database: one log line and no summary.
const unreachableLine = JSON.stringify({
  fields: {
    level: "ERROR",
    message:
      "failed to fetch advisory database https://github.com/RustSec/advisory-db with cli: " +
      "fatal: unable to access 'https://github.com/RustSec/advisory-db/': Couldn't connect to server\n",
  },
  type: "log",
});

const reported = parseDenyOutput(`${advisoryLine}\n${failingSummary}\n`);

const acceptance: Acceptance = {
  advisory: "RUSTSEC-2099-0001",
  crate: "ahash",
  reason: "Seeded for the test; the crate never hashes attacker-chosen keys through ahash.",
  reviewBy: "2027-03-01",
};

describe("collectFindings", () => {
  it("reads one finding per advisory diagnostic, with the path from the workspace", () => {
    expect(collectFindings(reported)).toEqual([
      {
        advisory: "RUSTSEC-2099-0001",
        kind: "vulnerability",
        crate: "ahash",
        version: "0.8.12",
        dependencyPath: "workhorse>jsonschema>ahash",
        title: "Seeded advisory for SM-895 verification",
        url: "https://rustsec.org/advisories/RUSTSEC-2099-0001",
        solution: "Upgrade to >=0.8.99 (try `cargo update -p ahash`)",
      },
    ]);
  });

  it("finds nothing in a clean tree", () => {
    expect(collectFindings(parseDenyOutput(`${cleanSummary}\n`))).toEqual([]);
  });
});

describe("findProblems", () => {
  const findings = collectFindings(reported);

  it("accepts an advisory the list names for that crate", () => {
    expect(findProblems(findings, [acceptance], "2026-09-23")).toEqual([]);
  });

  it("fails on an advisory no entry covers, naming the advisory and the acceptance file", () => {
    const problems = findProblems(findings, [], "2026-09-23");
    expect(problems).toHaveLength(1);
    const message = describeProblems(problems);
    expect(message).toContain(
      `RUSTSEC-2099-0001 in ahash is not accepted in ${acceptanceFileName}`,
    );
    expect(message).toContain("path: workhorse>jsonschema>ahash");
  });

  it("does not let an entry for one crate accept the same advisory in another", () => {
    const problems = findProblems(findings, [{ ...acceptance, crate: "hashbrown" }], "2026-09-23");
    expect(problems.map((problem) => problem.headline)).toEqual([
      `Advisory RUSTSEC-2099-0001 in ahash is not accepted in ${acceptanceFileName}`,
      "Acceptance of advisory RUSTSEC-2099-0001 matches nothing cargo deny reports",
    ]);
  });

  it("fails once an entry's review date has passed", () => {
    const problems = findProblems(findings, [acceptance], "2027-03-02");
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toContain("due for review on 2027-03-01");
  });

  it("fails on an entry that matches nothing cargo deny reports", () => {
    const problems = findProblems([], [acceptance], "2026-09-23");
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toContain("matches nothing");
  });
});

describe("findUnexplainedErrors", () => {
  it("fails on an error that is not an advisory, which no acceptance can answer", () => {
    const records: readonly DenyRecord[] = [
      {
        type: "diagnostic",
        fields: { code: "unmatched-source", message: "source not allowed", severity: "error" },
      },
      { type: "diagnostic", fields: { code: "index-failure", severity: "warning" } },
    ];
    const problems = findUnexplainedErrors(records);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe("cargo deny reported unmatched-source: source not allowed");
  });

  it("leaves advisory diagnostics to the acceptance list", () => {
    expect(findUnexplainedErrors(reported)).toEqual([]);
  });
});

describe("the committed acceptance list", () => {
  it("gives every entry a RustSec identifier, a reason, and a review date that has not passed", async () => {
    const file = JSON.parse(
      await readFile(path.join(repositoryRoot, acceptanceFileName), "utf8"),
    ) as { acceptances: readonly Acceptance[] };
    const today = new Date().toISOString().slice(0, 10);
    for (const entry of file.acceptances) {
      expect(entry.advisory).toMatch(/^RUSTSEC-\d{4}-\d{4}$/);
      expect(entry.crate.length).toBeGreaterThan(0);
      expect(entry.reason.length, `${entry.advisory} states no reason`).toBeGreaterThan(40);
      expect(
        entry.reviewBy >= today,
        `${entry.advisory} is past its review ${entry.reviewBy}`,
      ).toBe(true);
    }
  });
});

function refusal(records: readonly DenyRecord[]): string {
  try {
    requireReadableReport(records, "", 1);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("A run without a summary was not refused");
}

// cargo-deny exits 1 both on an advisory and on a database it could not fetch. A security gate that
// read the second as the first would send a maintainer to delete reviewed acceptances during an
// outage, and one that read it as a clean tree would pass a build nothing checked.
describe("a run that never read the advisory database", () => {
  const unreachable = parseDenyOutput(`${unreachableLine}\n`);

  it("is refused, naming the database and cargo-deny's own reason", () => {
    const message = refusal(unreachable);
    expect(message).toContain("without checking Cargo.lock against the RustSec advisory database");
    expect(message).toContain("failed to fetch advisory database");
    expect(message).toContain("Couldn't connect to server");
  });

  it("does not send the reader to the acceptance list", () => {
    const message = refusal(unreachable);
    expect(message).toContain(`no acceptance in ${acceptanceFileName} is stale`);
    expect(message).not.toContain("is not accepted");
    expect(message).not.toContain("Delete the entry");
  });

  it("refuses output that is not JSON at all, quoting it", () => {
    expect(refusal(parseDenyOutput("error: unexpected argument\n"))).toContain(
      "error: unexpected argument",
    );
  });

  it("passes a clean run, which ends with a summary", () => {
    const clean = parseDenyOutput(`${cleanSummary}\n`);
    expect(requireReadableReport(clean)).toBe(clean);
  });

  it("passes a run that reports an advisory, so the advisory is judged against the list", () => {
    expect(requireReadableReport(reported)).toBe(reported);
  });
});
