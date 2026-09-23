import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  consumerManifest,
  httpDependencies,
  publishedCrate,
  scratchDatabaseName,
} from "./check-rust-release.js";
import { repositoryRoot } from "./packages.js";
import { classifyTestDatabase, testFamilyRoots } from "./test-database-sweep.js";

type Workspace = Parameters<typeof publishedCrate>[0];
type Package = Workspace["packages"][number];

function member(name: string, directory: string, publish: string[] | null): Package {
  return {
    id: `path+file://${directory}#${name}@0.1.0`,
    name,
    version: "0.1.0",
    manifest_path: path.join(repositoryRoot, directory, "Cargo.toml"),
    publish,
    features: {},
    source: null,
    description: "A crate",
    license: "Apache-2.0",
    repository: "https://github.com/stablemates/workhorse",
    readme: "README.md",
    keywords: ["postgresql"],
    rust_version: "1.89",
  };
}

function workspace(...packages: Package[]): Workspace {
  return {
    packages,
    workspace_members: packages.map((candidate) => candidate.id),
    target_directory: path.join(repositoryRoot, "target"),
  };
}

describe("the published Rust crate", () => {
  it("ignores a member marked publish = false", () => {
    const crate = publishedCrate(
      workspace(member("workhorse", "rust", null), member("worker", "rust/worker", [])),
    );
    expect(crate.name).toBe("workhorse");
  });

  it("refuses a second publishable member", () => {
    expect(() =>
      publishedCrate(
        workspace(member("workhorse", "rust", null), member("worker", "rust/worker", null)),
      ),
    ).toThrow("the workspace publishes workhorse, worker");
  });

  it("requires the crate rooted at rust/", () => {
    expect(() => publishedCrate(workspace(member("workhorse", "crates/sdk", null)))).toThrow(
      "must be rooted at rust/",
    );
  });

  it("requires the metadata a crates.io page shows", () => {
    const crate = { ...member("workhorse", "rust", null), description: null, keywords: [] };
    expect(() => publishedCrate(workspace(crate))).toThrow("description, keywords");
  });
});

describe("the release consumer", () => {
  it("imports the crate as workhorse under any package name", () => {
    const manifest = consumerManifest(
      { name: "stablemates-workhorse", version: "0.2.0" },
      "/tmp/unpacked",
    );
    expect(manifest).toContain(
      'workhorse = { package = "stablemates-workhorse", version = "=0.2.0" }',
    );
    expect(manifest).toContain('"stablemates-workhorse" = { path = "/tmp/unpacked" }');
    expect(manifest).toMatch(/\[workspace\]\n$/);
  });

  it("names the HTTP crates a dependency tree resolves", () => {
    const tree = ["workhorse v0.1.0", "bytes v1.10.1", "http-body v1.0.1", "tokio v1.47.1"];
    expect(httpDependencies(tree.join("\n"))).toEqual(["http-body"]);
    expect(httpDependencies("workhorse v0.1.0\nhttparse v1.10.1\n")).toEqual([]);
  });

  it("names a scratch database that pnpm db:sweep can drop", () => {
    const source = "workhorse_test_eagleanton_sm_880_rust_r_7dd0819c";
    const scratch = scratchDatabaseName(source, 4242);
    expect(scratch.length).toBeLessThanOrEqual(63);
    expect(
      classifyTestDatabase(scratch, {
        protectedNames: new Set([source]),
        familyRoots: testFamilyRoots([source]),
        currentTemplate: "",
      }),
    ).toEqual({ kind: "scratch", retired: true });
  });
});
