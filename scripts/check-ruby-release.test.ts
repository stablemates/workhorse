import { describe, expect, it } from "vitest";

import {
  consumerEnvironment,
  packagedFileProblems,
  scratchDatabaseName,
} from "./check-ruby-release.js";
import { classifyTestDatabase, testFamilyRoots } from "./test-database-sweep.js";

const carried = [
  "lib/stablemates/workhorse.rb",
  "lib/stablemates/workhorse/version.rb",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
];

describe("the packaged Ruby gem", () => {
  it("accepts an archive that carries the library and its documents", () => {
    expect(packagedFileProblems(carried)).toEqual([]);
  });

  it("names a required file the archive lacks", () => {
    expect(packagedFileProblems(carried.filter((file) => file !== "CHANGELOG.md"))).toEqual([
      "the gem does not carry CHANGELOG.md",
    ]);
  });

  it("refuses files that belong to the checkout", () => {
    expect(packagedFileProblems([...carried, "spec/queue_spec.rb"])).toEqual([
      "the gem carries spec/queue_spec.rb, which belongs to the checkout",
    ]);
  });
});

describe("the release consumer", () => {
  it("drops the checkout's Bundler and gem settings and isolates the gem home", () => {
    const environment = consumerEnvironment(
      {
        PATH: "/usr/bin",
        BUNDLE_GEMFILE: "/checkout/ruby/Gemfile",
        BUNDLER_VERSION: "2.6.9",
        GEM_PATH: "/checkout/gems",
        RUBYOPT: "-rbundler/setup",
        RUBYLIB: "/checkout/ruby/lib",
      },
      "/tmp/gems",
    );
    expect(environment).toEqual({
      PATH: "/usr/bin",
      GEM_HOME: "/tmp/gems",
      GEM_PATH: "/tmp/gems",
      GEM_SPEC_CACHE: "/tmp/gems",
    });
  });

  it("names a scratch database that pnpm db:sweep can drop", () => {
    const source = "workhorse_test_eagleanton_sm_903_ruby_r_82d1";
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
