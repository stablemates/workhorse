import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Acceptance,
  type AdvisoryFinding,
  acceptanceFileName,
  collectFindings,
  describeProblems,
  findProblems,
  findUnexplainedResults,
  lockfilesToAudit,
  parseAcceptances,
  parseAuditReport,
  parseDatabaseStats,
  readAdvisoryTree,
} from "./audit-ruby-dependencies.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// Trimmed from a real `bundle-audit check --format json` run of ruby/Gemfile.lock against a
// database seeded with one advisory for pg. The lockfile names pg for several platforms, and
// bundler-audit reports the advisory once for each of them.
const pgResult = {
  type: "unpatched_gem",
  gem: { name: "pg", version: "1.6.3" },
  advisory: {
    path: "/tmp/sm999-seeded-db/gems/pg/GHSA-sm99-9999-0001.yml",
    id: "GHSA-sm99-9999-0001",
    url: "https://github.com/advisories/GHSA-sm99-9999-0001",
    title: "Seeded advisory for SM-999 verification",
    date: "2026-09-30",
    description: "A seeded advisory that every locked pg version is affected by.",
    cvss_v2: null,
    cvss_v3: 7.5,
    cve: null,
    osvdb: null,
    ghsa: "sm99-9999-0001",
    unaffected_versions: [],
    patched_versions: [">= 99.0.0"],
    criticality: "high",
  },
};
const reportedOutput = JSON.stringify({
  version: "0.9.3",
  created_at: "2026-09-30 21:00:12 -0400",
  results: [pgResult, pgResult, pgResult],
});
const cleanOutput = JSON.stringify({
  version: "0.9.3",
  created_at: "2026-09-30 21:00:12 -0400",
  results: [],
});
const statsOutput = `ruby-advisory-db:
  advisories:\t1251 advisories
  last updated:\t2026-09-29 09:12:40 -0400
  commit:\tcb6460a5876f3bf6ef908718457bfa9dd4ca9c06
`;

const reported = collectFindings(
  "Gemfile.lock",
  parseAuditReport("Gemfile.lock", reportedOutput, 1),
);
const accepted: Acceptance = {
  advisory: "GHSA-sm99-9999-0001",
  gem: "pg",
  reason: "Seeded for the test; the affected function is never called by the gem.",
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

describe("findings from bundle-audit", () => {
  it("reads one finding per advisory and gem, however many platforms repeat it", () => {
    expect(reported).toEqual<AdvisoryFinding[]>([
      {
        lockfile: "Gemfile.lock",
        advisory: "GHSA-sm99-9999-0001",
        gem: "pg",
        version: "1.6.3",
        title: "Seeded advisory for SM-999 verification",
        url: "https://github.com/advisories/GHSA-sm99-9999-0001",
        patchedVersions: [">= 99.0.0"],
      },
    ]);
  });

  it("finds nothing in a clean lockfile", () => {
    expect(
      collectFindings("Gemfile.lock", parseAuditReport("Gemfile.lock", cleanOutput, 0)),
    ).toEqual([]);
  });

  it("fails on an advisory no entry covers, naming the lockfile and the acceptance file", () => {
    const message = describeProblems(findProblems(reported, [], "2026-09-30"));
    expect(message).toContain(
      `Advisory GHSA-sm99-9999-0001 in pg is not accepted in ${acceptanceFileName}`,
    );
    expect(message).toContain("pg@1.6.3 in ruby/Gemfile.lock");
    expect(message).toContain("upgrade to >= 99.0.0");
  });

  it("accepts an advisory the list names for that gem", () => {
    expect(findProblems(reported, [accepted], "2026-09-30")).toEqual([]);
  });

  it("does not let an entry for one gem accept the same advisory in another", () => {
    const problems = findProblems(reported, [{ ...accepted, gem: "rack" }], "2026-09-30");
    expect(problems.map((problem) => problem.headline)).toEqual([
      `Advisory GHSA-sm99-9999-0001 in pg is not accepted in ${acceptanceFileName}`,
      "Acceptance of advisory GHSA-sm99-9999-0001 matches nothing bundle-audit reports",
    ]);
  });

  it("fails once an entry's review date has passed", () => {
    const problems = findProblems(
      reported,
      [{ ...accepted, reviewBy: "2026-09-29" }],
      "2026-09-30",
    );
    expect(problems.map((problem) => problem.headline)).toContain(
      "Acceptance of advisory GHSA-sm99-9999-0001 was due for review on 2026-09-29",
    );
  });

  it("fails on an entry that matches nothing in any lockfile", () => {
    expect(findProblems([], [accepted], "2026-09-30").map((problem) => problem.headline)).toEqual([
      "Acceptance of advisory GHSA-sm99-9999-0001 matches nothing bundle-audit reports",
    ]);
  });

  it("fails on an insecure gem source, which no acceptance can answer", () => {
    const results = parseAuditReport(
      "Gemfile.lock",
      JSON.stringify({ results: [{ type: "insecure_source", source: "http://rubygems.org/" }] }),
      1,
    );
    expect(collectFindings("Gemfile.lock", results)).toEqual([]);
    expect(findUnexplainedResults("Gemfile.lock", results)).toEqual([
      {
        headline: "bundle-audit reported insecure_source in Gemfile.lock",
        detail: ["http://rubygems.org/"],
      },
    ]);
  });
});

// bundler-audit reports a clean lockfile when its database is empty or was never refreshed. A gate
// that read either as a clean tree would pass a build nothing checked, and one that read an outage as
// an advisory would send a maintainer to edit reviewed acceptances.
describe("a run that cannot vouch for its database", () => {
  it("reads the size and revision of a refreshed database", () => {
    expect(parseDatabaseStats(statsOutput)).toEqual({
      advisories: 1251,
      commit: "cb6460a5876f3bf6ef908718457bfa9dd4ca9c06",
      lastUpdated: "2026-09-29 09:12:40 -0400",
    });
  });

  it("is refused when the database holds no advisories", () => {
    const message = refusal(() =>
      parseDatabaseStats(
        "ruby-advisory-db:\n  advisories:\t0 advisories\n  last updated:\tnever\n",
      ),
    );
    expect(message).toContain("the database holds no advisories");
    expect(message).toContain(`no acceptance in ${acceptanceFileName} is stale`);
    expect(message).not.toContain("is not accepted");
  });

  it("is refused when the database is not a git checkout that can be refreshed", () => {
    const withoutCommit = statsOutput.replace(/^ {2}commit:.*\n/m, "");
    expect(refusal(() => parseDatabaseStats(withoutCommit))).toContain("not a git checkout");
  });

  it("is refused when stats writes nothing it can read", () => {
    expect(refusal(() => parseDatabaseStats(""))).toContain("the database holds no advisories");
  });

  it("refuses a check that wrote no report, quoting its output", () => {
    const message = refusal(() =>
      parseAuditReport("Gemfile.lock", "Could not find gem 'bundler-audit'", 1),
    );
    expect(message).toContain("checking Gemfile.lock wrote no JSON report");
    expect(message).toContain("Could not find gem 'bundler-audit'");
  });

  it("refuses an exit code that is neither clean nor vulnerable", () => {
    expect(refusal(() => parseAuditReport("Gemfile.lock", cleanOutput, 2))).toContain(
      "checking Gemfile.lock exited with 2",
    );
  });

  it("refuses a vulnerable exit that reports nothing", () => {
    expect(refusal(() => parseAuditReport("Gemfile.lock", cleanOutput, 1))).toContain(
      "exited with 1 but reported nothing",
    );
  });

  it("refuses a report without a results list", () => {
    expect(refusal(() => parseAuditReport("Gemfile.lock", "{}", 0))).toContain(
      "has no results list",
    );
  });
});

describe("a database tree the run cannot read", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const directory of scratch.splice(0)) {
      await chmod(path.join(directory, "gems", "pg"), 0o755);
      await chmod(path.join(directory, "gems", "pg", "GHSA-sm99-9999-0001.yml"), 0o644);
      await rm(directory, { recursive: true, force: true });
    }
  });

  // A pg advisory beside a readable advisory for another gem: bundler-audit's glob would skip an
  // unlistable gems/pg, still count the other advisory, and report pg as clean.
  async function seededDatabase(): Promise<string> {
    const database = await mkdtemp(path.join(tmpdir(), "sm999-advisory-tree-"));
    scratch.push(database);
    for (const [gem, advisory] of [
      ["pg", "GHSA-sm99-9999-0001"],
      ["rack", "GHSA-sm99-9999-0002"],
    ] as const) {
      await mkdir(path.join(database, "gems", gem), { recursive: true });
      await writeFile(path.join(database, "gems", gem, `${advisory}.yml`), `gem: ${gem}\n`);
    }
    return database;
  }

  it("counts every advisory in a readable tree", async () => {
    expect(await readAdvisoryTree(await seededDatabase())).toBe(2);
  });

  it("is refused when one gem's advisory directory cannot be listed", async () => {
    const database = await seededDatabase();
    await chmod(path.join(database, "gems", "pg"), 0o000);
    await expect(readAdvisoryTree(database)).rejects.toThrow(
      /could not check the Ruby lockfiles[\s\S]*cannot list .*gems\/pg/,
    );
  });

  it("is refused when one advisory file cannot be read", async () => {
    const database = await seededDatabase();
    await chmod(path.join(database, "gems", "pg", "GHSA-sm99-9999-0001.yml"), 0o000);
    await expect(readAdvisoryTree(database)).rejects.toThrow(
      /cannot read .*GHSA-sm99-9999-0001\.yml/,
    );
  });

  it("is refused when the tree holds no advisory files", async () => {
    const database = await mkdtemp(path.join(tmpdir(), "sm999-advisory-tree-"));
    try {
      await mkdir(path.join(database, "gems"));
      await expect(readAdvisoryTree(database)).rejects.toThrow(/holds no advisory files/);
    } finally {
      await rm(database, { recursive: true, force: true });
    }
  });
});

function acceptanceList(entry: Record<string, unknown>): string {
  return JSON.stringify({ acceptances: [entry] });
}

describe("an acceptance list the run cannot judge", () => {
  it("reads a list whose every entry has a reason and a calendar review date", () => {
    expect(parseAcceptances(acceptanceList({ ...accepted }))).toEqual([accepted]);
  });

  it.each([
    ["a review date that is a word", { reviewBy: "never" }, /reviewBy "never"/],
    ["a review date that is not on the calendar", { reviewBy: "2026-99-99" }, /"2026-99-99"/],
    ["a missing review date", { reviewBy: undefined }, /reviewBy undefined/],
    ["a missing reason", { reason: undefined }, /has no reason/],
    ["a blank reason", { reason: "   " }, /has no reason/],
  ])("is refused for %s", (_name, change, message) => {
    expect(() => parseAcceptances(acceptanceList({ ...accepted, ...change }))).toThrow(message);
  });

  it("is refused when the file has no acceptances list", () => {
    expect(() => parseAcceptances("{}")).toThrow(/has no acceptances list/);
  });
});

describe("the audited lockfiles", () => {
  it("are the gem's lockfile and every locked Rails gemfile", async () => {
    const locked = (await readdir(path.join(repositoryRoot, "ruby", "gemfiles")))
      .filter((name) => name.endsWith(".gemfile.lock"))
      .map((name) => `gemfiles/${name}`);
    expect(locked.length).toBeGreaterThan(0);
    expect(await lockfilesToAudit()).toEqual(["Gemfile.lock", ...locked.toSorted()]);
  });
});

describe("the committed acceptance list", () => {
  it("gives every entry an advisory, a gem, a reason, and a review date that has not passed", async () => {
    const acceptances = parseAcceptances(
      await readFile(path.join(repositoryRoot, acceptanceFileName), "utf8"),
    );
    const today = new Date().toISOString().slice(0, 10);
    for (const entry of acceptances) {
      expect(entry.advisory).toMatch(
        /^(CVE-\d{4}-\d+|GHSA(-[23456789cfghjmpqrvwx]{4}){3}|OSVDB-\d+)$/,
      );
      expect(entry.gem.length).toBeGreaterThan(0);
      expect(entry.reason.length, `${entry.advisory} states no reason`).toBeGreaterThan(40);
      expect(
        entry.reviewBy >= today,
        `${entry.advisory} is past its review ${entry.reviewBy}`,
      ).toBe(true);
    }
  });
});
