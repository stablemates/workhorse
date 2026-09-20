import { describe, expect, it } from "vitest";
import type { PublishedPackage } from "./packages.js";
import {
  type OidcIdentity,
  condenseDiagnostics,
  describeLedger,
  describeProblems,
  findPreflightProblems,
  meetsMinimum,
  parseVersions,
  readOidcIdentity,
} from "./publish-npm.js";

function published(name: string, version = "0.1.0"): PublishedPackage {
  const directory = name.replace("@stablemates/workhorse", "").replace(/^-/, "") || "core";
  return {
    name,
    directory,
    location: `typescript/${directory}`,
    manifest: `typescript/${directory}/package.json`,
    version,
    tarball: `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`,
  };
}

const core = published("@stablemates/workhorse");
const dashboard = published("@stablemates/workhorse-dashboard");
const packages = [core, dashboard];

/** The npm the publish job runs, and an identity for it to exchange. */
const publisher = "11.5.1";
const offered: OidcIdentity = { offered: true };

/** Neither package has ever been published, which is the state before a first release. */
const unpublished = new Map([
  [core.name, undefined],
  [dashboard.name, undefined],
]);

/** Both packages exist at an earlier version, which is the state before every later release. */
const atBeta = new Map<string, readonly string[] | undefined>([
  [core.name, ["0.1.0-beta.2"]],
  [dashboard.name, ["0.1.0-beta.2"]],
]);

describe("meetsMinimum", () => {
  it("compares the three numbers npm releases under", () => {
    expect(meetsMinimum("11.5.1", "11.5.1")).toBe(true);
    expect(meetsMinimum("11.19.0", "11.5.1")).toBe(true);
    expect(meetsMinimum("12.0.0", "11.5.1")).toBe(true);
    expect(meetsMinimum("11.5.0", "11.5.1")).toBe(false);
    expect(meetsMinimum("10.9.8", "11.5.1")).toBe(false);
  });

  it("refuses a version it cannot read rather than guess at it", () => {
    expect(meetsMinimum("", "11.5.1")).toBe(false);
    expect(meetsMinimum("next", "11.5.1")).toBe(false);
  });
});

describe("readOidcIdentity", () => {
  it("takes the two variables GitHub sets for a job that asked for id-token: write", () => {
    const identity = readOidcIdentity({
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/...",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    });
    expect(identity).toEqual({ offered: true });
  });

  it("names the missing permission when the job runs without a token endpoint", () => {
    const identity = readOidcIdentity({ GITHUB_ACTIONS: "true" });
    expect(identity.offered).toBe(false);
    expect(identity.offered === false && identity.detail).toContain("id-token: write");
  });

  it("names the run itself when npm has no CI to exchange an identity with", () => {
    const identity = readOidcIdentity({});
    expect(identity.offered).toBe(false);
    expect(identity.offered === false && identity.detail).toContain("GitHub Actions");
  });
});

describe("findPreflightProblems", () => {
  it("passes an OIDC publisher with no target version on the registry", () => {
    expect(findPreflightProblems(packages, publisher, offered, atBeta)).toEqual([]);
    expect(findPreflightProblems(packages, publisher, offered, unpublished)).toEqual([]);
  });

  it("refuses an npm too old to exchange an identity, and says where to raise it", () => {
    const problems = findPreflightProblems(packages, "10.9.8", offered, atBeta);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe("npm 10.9.8 cannot exchange an OIDC identity");
    const message = describeProblems(problems);
    expect(message).toContain("that exchange in 11.5.1");
    expect(message).toContain("Raise node-version in the publish job");
  });

  it("refuses an npm it could not ask for a version", () => {
    const problems = findPreflightProblems(packages, undefined, offered, atBeta);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe("npm did not report a version");
  });

  it("refuses a run with no identity to publish with, and says what publication uses", () => {
    const oidc: OidcIdentity = {
      offered: false,
      detail: "npm exchanges an OIDC identity only in CI.",
    };
    const problems = findPreflightProblems(packages, publisher, oidc, atBeta);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe("No OIDC identity is available to publish with");
    const message = describeProblems(problems);
    expect(message).toContain("npm publish exchanges that identity");
    expect(message).toContain("The repository holds no npm token.");
    expect(message).toContain(".github/workflows/release.yml");
  });

  it("reports a partial release as one problem naming both sides", () => {
    const partial = new Map<string, readonly string[] | undefined>([
      [core.name, ["0.1.0-beta.2", "0.1.0"]],
      [dashboard.name, ["0.1.0-beta.2"]],
    ]);
    const problems = findPreflightProblems(packages, publisher, offered, partial);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe("The registry already holds 1 of 2 packages at 0.1.0");
    const message = describeProblems(problems);
    expect(message).toContain("Already on the registry:\n    @stablemates/workhorse@0.1.0");
    expect(message).toContain("Not on the registry:\n    @stablemates/workhorse-dashboard@0.1.0");
    expect(message).toContain("Recover it with docs/compatibility.md");
  });

  it("reports a version that is already fully published without calling it partial", () => {
    const complete = new Map<string, readonly string[] | undefined>([
      [core.name, ["0.1.0"]],
      [dashboard.name, ["0.1.0"]],
    ]);
    const problems = findPreflightProblems(packages, publisher, offered, complete);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe("Every package is already published at 0.1.0");
    expect(describeProblems(problems)).not.toContain("Not on the registry");
  });
});

describe("describeLedger", () => {
  it("names every package a completed run published", () => {
    const report = describeLedger({ published: packages, pending: [] });
    expect(report).toContain("Published 2 package(s) at 0.1.0:");
    expect(report).toContain("  @stablemates/workhorse@0.1.0");
    expect(report).toContain("  @stablemates/workhorse-dashboard@0.1.0");
  });

  it("separates what published from what failed and what was never attempted", () => {
    const third = published("@stablemates/workhorse-hono");
    const report = describeLedger({
      published: [core],
      failure: { entry: dashboard, detail: "npm publish exited with 1" },
      pending: [third],
    });
    expect(report).toContain("npm publication stopped at package 2 of 3.");
    expect(report).toContain("Published, and permanent");
    expect(report).toContain("  @stablemates/workhorse@0.1.0");
    expect(report).toContain("Failed:\n  @stablemates/workhorse-dashboard@0.1.0");
    expect(report).toContain("Not attempted:\n  @stablemates/workhorse-hono@0.1.0");
    expect(report).toContain("npm now holds a partial 0.1.0 release");
  });

  it("says the registry is unchanged when the first package failed", () => {
    const report = describeLedger({
      published: [],
      failure: { entry: core, detail: "npm publish exited with 1" },
      pending: [dashboard],
    });
    expect(report).toContain("Published: nothing. The registry is unchanged.");
    expect(report).toContain("this tag can be released again");
    expect(report).not.toContain("partial");
  });
});

describe("condenseDiagnostics", () => {
  it("keeps the reason npm failed and drops what it prints on every run", () => {
    const output = [
      'npm warn Unknown env config "verify-deps-before-run". This will stop working.',
      "npm error code E401",
      "npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami",
      "npm error A complete log of this run can be found in: .npm/_logs/2026-09-04T01_04_49Z.log",
    ].join("\n");

    expect(condenseDiagnostics(output)).toBe(
      "code E401; 401 Unauthorized - GET https://registry.npmjs.org/-/whoami",
    );
  });
});

describe("parseVersions", () => {
  it("reads the bare string npm prints for a package with one version", () => {
    expect(parseVersions('"0.1.0"')).toEqual(["0.1.0"]);
  });

  it("reads a version list and an empty answer", () => {
    expect(parseVersions('["0.1.0-beta.1","0.1.0-beta.2"]')).toEqual([
      "0.1.0-beta.1",
      "0.1.0-beta.2",
    ]);
    expect(parseVersions("  ")).toEqual([]);
  });
});
