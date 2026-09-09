import { describe, expect, it } from "vitest";
import type { PublishedPackage } from "./packages.js";
import {
  type Credential,
  type ScopeAccess,
  condenseDiagnostics,
  describeLedger,
  describeProblems,
  findPreflightProblems,
  packageScope,
  parseVersions,
  publishedScopes,
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

const accepted: Credential = { accepted: true, username: "stablemates-release" };

function listed(...names: readonly string[]): ReadonlyMap<string, ScopeAccess> {
  return new Map([
    [
      "@stablemates",
      {
        kind: "listed",
        permissions: Object.fromEntries(names.map((name) => [name, "read-write"])),
      } satisfies ScopeAccess,
    ],
  ]);
}

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

describe("packageScope", () => {
  it("reads the scope from a scoped name and finds none in a bare one", () => {
    expect(packageScope("@stablemates/workhorse-dashboard")).toBe("@stablemates");
    expect(packageScope("workhorse")).toBeUndefined();
  });

  it("lists each scope once, in the order the packages publish", () => {
    expect(publishedScopes(packages)).toEqual(["@stablemates"]);
  });
});

describe("findPreflightProblems", () => {
  it("passes a credential with write access and no target version on the registry", () => {
    const problems = findPreflightProblems(
      packages,
      accepted,
      listed(core.name, dashboard.name),
      atBeta,
    );
    expect(problems).toEqual([]);
  });

  it("names the credential rather than the package when the registry refuses the token", () => {
    const credential: Credential = { accepted: false, detail: "npm error code E401" };
    const problems = findPreflightProblems(packages, credential, new Map(), atBeta);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe("The registry refused the NPM_TOKEN credential");
    expect(describeProblems(problems)).toContain("Rotate NPM_TOKEN in the npm environment");
  });

  it("refuses a credential the registry will not let read the scope", () => {
    const access = new Map<string, ScopeAccess>([
      ["@stablemates", { kind: "refused", detail: "npm error code E403" }],
    ]);
    const problems = findPreflightProblems(packages, accepted, access, atBeta);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe("NPM_TOKEN cannot read the @stablemates scope");
  });

  it("refuses a credential the scope listing omits for a package that exists", () => {
    const problems = findPreflightProblems(packages, accepted, listed(core.name), atBeta);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe(
      "NPM_TOKEN may not publish @stablemates/workhorse-dashboard",
    );
  });

  it("refuses read-only access to a package", () => {
    const access = new Map<string, ScopeAccess>([
      [
        "@stablemates",
        {
          kind: "listed",
          permissions: { [core.name]: "read-write", [dashboard.name]: "read-only" },
        },
      ],
    ]);
    const problems = findPreflightProblems(packages, accepted, access, atBeta);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.headline).toBe(
      "NPM_TOKEN has read-only access to @stablemates/workhorse-dashboard",
    );
  });

  it("lets a package that has never been published through an omission it cannot avoid", () => {
    expect(findPreflightProblems(packages, accepted, listed(), unpublished)).toEqual([]);
  });

  it("acts on nothing when the registry declines to disclose the scope", () => {
    const access = new Map<string, ScopeAccess>([
      ["@stablemates", { kind: "undisclosed", detail: "npm error code E404" }],
    ]);
    expect(findPreflightProblems(packages, accepted, access, atBeta)).toEqual([]);
  });

  it("reports a partial release as one problem naming both sides", () => {
    const partial = new Map<string, readonly string[] | undefined>([
      [core.name, ["0.1.0-beta.2", "0.1.0"]],
      [dashboard.name, ["0.1.0-beta.2"]],
    ]);
    const problems = findPreflightProblems(
      packages,
      accepted,
      listed(core.name, dashboard.name),
      partial,
    );
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
    const problems = findPreflightProblems(
      packages,
      accepted,
      listed(core.name, dashboard.name),
      complete,
    );
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
