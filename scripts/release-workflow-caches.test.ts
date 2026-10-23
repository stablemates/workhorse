import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { actionSteps, type ActionStep } from "./workflow-steps.js";

// A release job builds or publishes what a registry receives. A dependency cache that it restores
// can hold content that an earlier, less trusted run wrote, such as a pull request run. So no
// release job restores a cache, and the lockfiles alone decide what it fetches (SM-1666).

const repository = path.resolve(import.meta.dirname, "..");
const workflowDirectory = path.join(repository, ".github/workflows");

/**
 * The cache input of each reviewed action whose cache is on by default, with the one value that
 * turns it off. A release step of that action must set the input to that value.
 */
const cacheSwitches: Record<string, { readonly input: string; readonly off: boolean }> = {
  // setup-node turns on the npm cache when package.json names npm in `packageManager` or in
  // `devEngines.packageManager`.
  "actions/setup-node": { input: "package-manager-cache", off: false },
  "actions-rust-lang/setup-rust-toolchain": { input: "cache", off: false },
  "astral-sh/setup-uv": { input: "enable-cache", off: false },
  "gradle/actions/setup-gradle": { input: "cache-disabled", off: true },
};

/**
 * The other actions that a release job may use. Each one restores no cache at its pinned ref when
 * it sets no input whose name contains `cache`. An action that is not in this list or in
 * `cacheSwitches` fails, so a person reviews its cache behavior before a release job uses it.
 */
const reviewedActions = new Set([
  "NuGet/login",
  "actions/checkout",
  "actions/download-artifact",
  "actions/setup-dotnet",
  "actions/setup-java",
  "actions/upload-artifact",
  "pnpm/action-setup",
  "ruby/setup-ruby",
  "rubygems/release-gem",
  "rust-lang/crates-io-auth-action",
  // It installs uv, with the uv cache, only when no uv is on the PATH. So it must follow a
  // setup-uv step of its job, which turns the cache off.
  "astral-sh/attest-action",
]);

function stepViolations(step: ActionStep, earlier: readonly ActionStep[], file: string): string[] {
  const cacheSwitch = cacheSwitches[step.action];
  if (!cacheSwitch && !reviewedActions.has(step.action))
    return [`${step.location} ${step.action} is not reviewed for release caches`];
  const violations: string[] = [];
  if (cacheSwitch && step.inputs.get(cacheSwitch.input)?.value !== cacheSwitch.off)
    violations.push(
      `${step.location} ${step.action} needs ${cacheSwitch.input}: ${cacheSwitch.off}`,
    );
  // A setup-uv step with another condition can skip while the attest step runs.
  if (
    step.action === "astral-sh/attest-action" &&
    !earlier.some(
      (other) =>
        other.job === step.job &&
        other.action === "astral-sh/setup-uv" &&
        (other.condition === undefined || other.condition === step.condition),
    )
  )
    violations.push(`${step.location} ${step.action} needs an earlier astral-sh/setup-uv`);
  for (const input of step.duplicateInputs)
    violations.push(`${step.location} ${step.action} sets ${input} twice`);
  for (const [input, { value, line }] of step.inputs) {
    if (!input.includes("cache") || input === cacheSwitch?.input) continue;
    violations.push(`${file}:${line} ${step.action} sets ${input}: ${String(value)}`);
  }
  return violations;
}

/** Each cache that a release workflow could restore, by location. */
function cacheViolations(file: string, source: string): string[] {
  const steps = actionSteps(file, source);
  return steps.flatMap((step, index) => stepViolations(step, steps.slice(0, index), file));
}

const releaseWorkflows = (await readdir(workflowDirectory))
  .filter((file) => /^release.*\.ya?ml$/.test(file))
  .toSorted();

describe("the release workflow caches", () => {
  it("reads every release workflow", () => {
    expect(releaseWorkflows).toEqual(["release-python.yml", "release.yml"]);
  });

  it.each(releaseWorkflows)("restores no dependency cache in %s", async (file) => {
    const source = await readFile(path.join(workflowDirectory, file), "utf8");
    expect(actionSteps(file, source).length).toBeGreaterThan(0);
    expect(cacheViolations(file, source)).toEqual([]);
  });

  it("rejects each cache that a release job could restore, with its location", () => {
    const source = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/setup-node@v7",
      "        with:",
      "          node-version: 22",
      "          cache: pnpm",
      "      - uses: actions-rust-lang/setup-rust-toolchain@v1",
      "        with:",
      "          toolchain: 1.89.0",
      "      - uses: astral-sh/setup-uv@v10",
      "        with:",
      "          enable-cache: true",
      "      - uses: gradle/actions/setup-gradle@v6",
      "      - uses: ruby/setup-ruby@v1",
      "        with:",
      "          bundler-cache: true",
      "      - uses: actions/cache/restore@v5",
      "      - uses: Swatinem/rust-cache@v2",
      "  attest:",
      "    steps:",
      "      - uses: astral-sh/attest-action@v0",
      "      - if: false",
      "        uses: astral-sh/setup-uv@v10",
      "        with:",
      "          enable-cache: false",
      "      - uses: astral-sh/attest-action@v0",
      "      - uses: ruby/setup-ruby@v1",
      "        with:",
      "          Bundler-Cache: true",
      "      - uses: actions/setup-node@v7",
      "        with:",
      "          package-manager-cache: false",
      "          Cache: pnpm",
      "      - uses: actions-rust-lang/setup-rust-toolchain@v1",
      "        with:",
      "          cache: false",
      "          Cache: true",
    ].join("\n");

    expect(cacheViolations("release.yml", source)).toEqual([
      "release.yml:4 build[0] actions/setup-node needs package-manager-cache: false",
      "release.yml:7 actions/setup-node sets cache: pnpm",
      "release.yml:8 build[1] actions-rust-lang/setup-rust-toolchain needs cache: false",
      "release.yml:11 build[2] astral-sh/setup-uv needs enable-cache: false",
      "release.yml:14 build[3] gradle/actions/setup-gradle needs cache-disabled: true",
      "release.yml:17 ruby/setup-ruby sets bundler-cache: true",
      "release.yml:18 build[5] actions/cache/restore is not reviewed for release caches",
      "release.yml:19 build[6] Swatinem/rust-cache is not reviewed for release caches",
      "release.yml:22 attest[0] astral-sh/attest-action needs an earlier astral-sh/setup-uv",
      "release.yml:27 attest[2] astral-sh/attest-action needs an earlier astral-sh/setup-uv",
      "release.yml:30 ruby/setup-ruby sets bundler-cache: true",
      "release.yml:34 actions/setup-node sets cache: pnpm",
      "release.yml:35 attest[5] actions-rust-lang/setup-rust-toolchain needs cache: false",
      "release.yml:35 attest[5] actions-rust-lang/setup-rust-toolchain sets cache twice",
    ]);
  });

  it("follows YAML aliases to the cache inputs that they set", () => {
    const source = [
      "x-cache: &cache true",
      "x-with: &with",
      "  cache: true",
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: pnpm/action-setup@v6",
      "        with: *with",
      "      - uses: actions-rust-lang/setup-rust-toolchain@v1",
      "        with:",
      "          cache: *cache",
    ].join("\n");

    expect(cacheViolations("release.yml", source)).toEqual([
      "release.yml:3 pnpm/action-setup sets cache: true",
      "release.yml:9 build[1] actions-rust-lang/setup-rust-toolchain needs cache: false",
    ]);
  });
});
