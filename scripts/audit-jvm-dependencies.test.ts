import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Acceptance,
  type PlanEntry,
  acceptanceFileName,
  batchQuery,
  canary,
  checkCanary,
  classPathLabel,
  collectFindings,
  describeProblems,
  distinctModules,
  findProblems,
  parseAcceptances,
  parseAdvisoryRecord,
  parseBatchAnswer,
  parseClassPathReport,
  parseExtra,
  publishedFeatures,
  scanPlan,
} from "./audit-jvm-dependencies.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// Trimmed from the Gradle module metadata that `pnpm jvm:vuln` publishes for the starter.
const starterMetadata = JSON.stringify({
  formatVersion: "1.1",
  component: { group: "run.workhorse", module: "workhorse-spring-boot-starter", version: "0.8.0" },
  variants: [
    { name: "apiElements" },
    { name: "runtimeElements" },
    {
      name: "jacksonRuntimeElements",
      capabilities: [
        { group: "run.workhorse", name: "workhorse-spring-boot-starter-jackson", version: "0.8.0" },
      ],
    },
    {
      name: "jacksonApiElements",
      capabilities: [
        { group: "run.workhorse", name: "workhorse-spring-boot-starter-jackson", version: "0.8.0" },
      ],
    },
    {
      name: "healthRuntimeElements",
      capabilities: [
        { group: "run.workhorse", name: "workhorse-spring-boot-starter-health", version: "0.8.0" },
      ],
    },
  ],
});

const pgjdbc = { group: "org.postgresql", name: "postgresql", version: "42.7.8" };
const commonsText = { group: "org.apache.commons", name: "commons-text", version: "1.9" };
const jackson = { group: "tools.jackson.core", name: "jackson-databind", version: "3.1.5" };

const plan: readonly PlanEntry[] = [
  { artifact: "workhorse", version: "0.8.0", features: [] },
  { artifact: "workhorse-spring-boot-starter", version: "0.8.0", features: ["jackson"] },
];

// The shape that `scripts/jvm-dependency-scan/build.gradle.kts` writes for that plan.
const report = [
  { artifact: "workhorse", features: [], modules: [pgjdbc], unresolved: [] },
  {
    artifact: "workhorse-spring-boot-starter",
    features: ["jackson"],
    modules: [pgjdbc, jackson],
    unresolved: [],
  },
];

// Trimmed from `GET https://api.osv.dev/v1/vulns/GHSA-599f-7c49-w659`, the known vulnerable
// commons-text 1.9 that a verification run passes with `--extra`.
const commonsTextRecord = {
  id: "GHSA-599f-7c49-w659",
  summary: "Arbitrary code execution in Apache Commons Text",
  aliases: ["CVE-2022-42889"],
  affected: [
    {
      package: { ecosystem: "Maven", name: "org.apache.commons:commons-text" },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "1.5" }, { fixed: "1.10.0" }] }],
    },
  ],
};

const accepted: Acceptance = {
  advisory: "GHSA-599f-7c49-w659",
  module: "org.apache.commons:commons-text",
  reason: "Fixture for the test; no artifact calls the affected interpolator.",
  reviewBy: "2099-01-01",
};

function refusal(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("The run was not refused");
}

/** The findings for one vulnerable `--extra` module, as the scan computes them. */
function extraFindings() {
  const modules = distinctModules([
    ...parseClassPathReport(JSON.stringify(report), plan),
    { artifact: "--extra", features: [], modules: [commonsText] },
  ]);
  const advisories = new Map([["org.apache.commons:commons-text:1.9", ["GHSA-599f-7c49-w659"]]]);
  const records = new Map([["GHSA-599f-7c49-w659", parseAdvisoryRecord(commonsTextRecord)]]);
  return collectFindings(modules, advisories, records);
}

describe("the class paths", () => {
  it("reads the optional features from the published module metadata", () => {
    expect(publishedFeatures("workhorse-spring-boot-starter", starterMetadata)).toEqual([
      "health",
      "jackson",
    ]);
    expect(
      refusal(() => publishedFeatures("workhorse", JSON.stringify({ variants: [] }))),
    ).toContain("has no variants");
  });

  it("resolves no feature, each feature, and every feature together", () => {
    const features = new Map([
      ["workhorse", ["opentelemetry", "servlet"]],
      ["workhorse-kotlin", []],
    ]);
    expect(scanPlan("0.8.0", features).map(classPathLabel)).toEqual([
      "workhorse[]",
      "workhorse[opentelemetry]",
      "workhorse[servlet]",
      "workhorse[opentelemetry,servlet]",
      "workhorse-kotlin[]",
    ]);
  });

  it("refuses a class path with a dependency that did not resolve", () => {
    const broken = [
      report[0],
      { ...report[1], unresolved: ["tools.jackson.core:jackson-databind: Could not find"] },
    ];
    expect(refusal(() => parseClassPathReport(JSON.stringify(broken), plan))).toContain(
      "workhorse-spring-boot-starter[jackson]: tools.jackson.core:jackson-databind: Could not find",
    );
  });

  it("refuses an empty class path and a report that does not match the plan", () => {
    const empty = [report[0], { ...report[1], modules: [] }];
    expect(refusal(() => parseClassPathReport(JSON.stringify(empty), plan))).toContain(
      "resolved no module outside run.workhorse",
    );
    expect(refusal(() => parseClassPathReport(JSON.stringify([report[0]]), plan))).toContain(
      "reported 1 class paths for a plan of 2",
    );
  });

  it("lists each module version once, with every class path that reaches it", () => {
    const modules = distinctModules(parseClassPathReport(JSON.stringify(report), plan));
    expect([...modules.keys()]).toEqual([
      "org.postgresql:postgresql:42.7.8",
      "tools.jackson.core:jackson-databind:3.1.5",
    ]);
    expect(modules.get("org.postgresql:postgresql:42.7.8")?.reachedBy).toEqual([
      "workhorse[]",
      "workhorse-spring-boot-starter[jackson]",
    ]);
  });

  it("reads an --extra coordinate, and refuses one that is not group:name:version", () => {
    expect(parseExtra("org.apache.commons:commons-text:1.9")).toEqual(commonsText);
    expect(refusal(() => parseExtra("commons-text:1.9"))).toContain("group:name:version");
  });
});

describe("the OSV answers", () => {
  it("asks about each module in the Maven ecosystem", () => {
    expect(batchQuery([pgjdbc])).toEqual({
      queries: [
        { package: { ecosystem: "Maven", name: "org.postgresql:postgresql" }, version: "42.7.8" },
      ],
    });
  });

  it("reads the identifiers and the page token of each result", () => {
    const answer = {
      results: [{}, { vulns: [{ id: "GHSA-1" }, { id: "GHSA-2" }], next_page_token: "next" }],
    };
    expect(parseBatchAnswer(answer, 2)).toEqual([
      { ids: [], nextPageToken: undefined },
      { ids: ["GHSA-1", "GHSA-2"], nextPageToken: "next" },
    ]);
  });

  it("refuses an answer with the wrong number of results, and says no decision was made", () => {
    const message = refusal(() => parseBatchAnswer({ results: [{}] }, 2));
    expect(message).toContain("1 results for 2 queries");
    expect(message).toContain("No decision was made");
  });

  it("refuses a result that is not an object, or a vulns field that is not a list", () => {
    for (const result of [false, null, [], "{}"]) {
      expect(refusal(() => parseBatchAnswer({ results: [{}, result] }, 2))).toContain(
        "instead of a result object",
      );
    }
    expect(refusal(() => parseBatchAnswer({ results: [{ vulns: {} }] }, 1))).toContain(
      "a vulns field that is not a list",
    );
  });

  it("refuses a batch that does not report the canary advisory", () => {
    expect(() => checkCanary({ ids: [canary.advisory], nextPageToken: undefined })).not.toThrow();
    expect(refusal(() => checkCanary({ ids: [], nextPageToken: undefined }))).toContain(
      `OSV did not report ${canary.advisory}`,
    );
  });

  it("reads the summary and the fixed versions of each Maven module", () => {
    const record = parseAdvisoryRecord(commonsTextRecord);
    expect(record.summary).toBe("Arbitrary code execution in Apache Commons Text");
    expect(record.withdrawn).toBe(false);
    expect(record.fixedVersions.get("org.apache.commons:commons-text")).toEqual(["1.10.0"]);
  });

  it("skips a withdrawn advisory", () => {
    const modules = distinctModules([
      { artifact: "--extra", features: [], modules: [commonsText] },
    ]);
    const advisories = new Map([["org.apache.commons:commons-text:1.9", ["GHSA-599f-7c49-w659"]]]);
    const withdrawn = parseAdvisoryRecord({
      ...commonsTextRecord,
      withdrawn: "2026-01-01T00:00:00Z",
    });
    expect(
      collectFindings(modules, advisories, new Map([["GHSA-599f-7c49-w659", withdrawn]])),
    ).toEqual([]);
  });
});

describe("the gate", () => {
  it("fails on a known vulnerable module that no acceptance covers", () => {
    const findings = extraFindings();
    expect(findings).toEqual([
      {
        advisory: "GHSA-599f-7c49-w659",
        module: "org.apache.commons:commons-text",
        version: "1.9",
        reachedBy: ["--extra[]"],
        title: "Arbitrary code execution in Apache Commons Text",
        url: "https://osv.dev/vulnerability/GHSA-599f-7c49-w659",
        fixedVersions: ["1.10.0"],
      },
    ]);
    const problems = findProblems(findings, [], "2026-10-18");
    expect(problems).toHaveLength(1);
    expect(describeProblems(problems)).toContain(
      `Advisory GHSA-599f-7c49-w659 in org.apache.commons:commons-text is not accepted in ${acceptanceFileName}`,
    );
    expect(describeProblems(problems)).toContain("fix:  upgrade to 1.10.0");
  });

  it("passes the same module when an acceptance covers it", () => {
    expect(findProblems(extraFindings(), [accepted], "2026-10-18")).toEqual([]);
  });

  it("does not let an acceptance for another module cover the advisory", () => {
    const elsewhere = { ...accepted, module: "org.apache.commons:commons-lang3" };
    const headlines = findProblems(extraFindings(), [elsewhere], "2026-10-18").map(
      (problem) => problem.headline,
    );
    expect(headlines).toContain(
      `Advisory GHSA-599f-7c49-w659 in org.apache.commons:commons-text is not accepted in ${acceptanceFileName}`,
    );
    expect(headlines).toContain(
      "Acceptance of advisory GHSA-599f-7c49-w659 matches nothing OSV reports",
    );
  });

  it("fails on an acceptance past its review date", () => {
    const due = { ...accepted, reviewBy: "2026-10-17" };
    expect(findProblems(extraFindings(), [due], "2026-10-18").map((p) => p.headline)).toEqual([
      "Acceptance of advisory GHSA-599f-7c49-w659 was due for review on 2026-10-17",
    ]);
  });

  it("refuses an acceptance list with an entry that cannot be judged", () => {
    const message = refusal(() =>
      parseAcceptances(
        JSON.stringify({
          acceptances: [{ advisory: "GHSA-1", module: "a:b", reason: " ", reviewBy: "2026-99-99" }],
        }),
      ),
    );
    expect(message).toContain("entry 0 (GHSA-1) has no reason");
    expect(message).toContain('has reviewBy "2026-99-99", which is not a YYYY-MM-DD date');
  });

  it("reads the committed acceptance list", async () => {
    const acceptances = parseAcceptances(
      await readFile(path.join(repositoryRoot, acceptanceFileName), "utf8"),
    );
    for (const acceptance of acceptances) {
      expect(acceptance.module).toMatch(/^[^:]+:[^:]+$/);
    }
  });
});
