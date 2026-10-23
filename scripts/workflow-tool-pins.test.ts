import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPins } from "./verify-toolchain.js";
import { actionSteps } from "./workflow-steps.js";

// A workflow writes each tool version out, because no setup action reads mise.toml. A tool bump
// that misses one step builds or publishes with a release that no local check ran. Each version
// input is one of three kinds, and this guard keeps them apart:
//
// - A pin carries the marker `# Pinned to the <tool> version in mise.toml.` and equals that pin.
// - A support-matrix version is a literal from the `tested` list of support.json, without the
//   marker, or a matrix that `scripts/ci-matrix.ts` makes from support.json. Such a matrix reaches
//   a step as `${{ matrix.<tool> }}` in a job whose matrix is a `plan` output, or as
//   `${{ fromJSON(needs.plan.outputs.<lane>).include[<n>].<tool> }}`.
// - A version file is only go/go.mod, whose `toolchain` line a test below holds to mise.toml.
// - Anything else fails with its location.

const repository = path.resolve(import.meta.dirname, "..");
const workflowDirectory = path.join(repository, ".github/workflows");

/** The input of each setup action that names a tool version, and the mise.toml tool it names. */
const versionInputs: Record<string, { readonly input: string; readonly tool: string }> = {
  "actions-rust-lang/setup-rust-toolchain": { input: "toolchain", tool: "rust" },
  "actions/setup-dotnet": { input: "dotnet-version", tool: "dotnet" },
  "actions/setup-go": { input: "go-version", tool: "go" },
  "actions/setup-java": { input: "java-version", tool: "java" },
  "actions/setup-node": { input: "node-version", tool: "node" },
  "actions/setup-python": { input: "python-version", tool: "python" },
  "astral-sh/setup-uv": { input: "version", tool: "uv" },
  "gradle/actions/setup-gradle": { input: "gradle-version", tool: "gradle" },
  "ruby/setup-ruby": { input: "ruby-version", tool: "ruby" },
};

/** One tool version that a workflow step names. */
interface ToolVersion {
  readonly location: string;
  readonly tool: string;
  readonly value: string;
  /** The tool that the marker comment names, if the line has one. */
  readonly marker: string | undefined;
  /** The `strategy.matrix` value of the job. */
  readonly matrix: unknown;
}

/** The only version file that a setup step may read, by action. */
const versionFiles: Record<string, string> = { "actions/setup-go": "go/go.mod" };

const planMatrix = /^\$\{\{ fromJSON\(needs\.plan\.outputs\.[\w-]+\) \}\}$/;
const planEntry = /^\$\{\{ fromJSON\(needs\.plan\.outputs\.[\w-]+\)\.include\[\d+\]\.(\w+) \}\}$/;

/** Whether an expression reads the tool version from a support.json matrix of the plan job. */
function readsPlanMatrix(value: string, tool: string, matrix: unknown): boolean {
  if (value === `\${{ matrix.${tool} }}`)
    return typeof matrix === "string" && planMatrix.test(matrix);
  return planEntry.exec(value)?.[1] === tool;
}

const markerPattern = /# Pinned to the (\S+) version in mise\.toml\./;

function toolVersions(file: string, source: string): ToolVersion[] {
  return actionSteps(file, source).flatMap((step): ToolVersion[] => {
    // taiki-e/install-action names each tool as `name@version`.
    if (step.action === "taiki-e/install-action") {
      const input = step.inputs.get("tool");
      if (!input) return [];
      const marker = markerPattern.exec(input.text)?.[1];
      return String(input.value)
        .split(",")
        .map((entry) => entry.trim().split("@"))
        .map(([tool = "", value = "none"]) => ({
          location: `${file}:${input.line} ${step.location.split(" ")[1]}`,
          tool,
          value,
          marker,
          matrix: step.matrix,
        }));
    }
    const named = versionInputs[step.action];
    if (!named) return [];
    const input = step.inputs.get(named.input);
    const versionFile = step.inputs.get(`${named.input}-file`);
    if (!input && versionFile) {
      const location = `${file}:${versionFile.line} ${step.location.split(" ")[1]}`;
      return versionFile.value === versionFiles[step.action]
        ? []
        : [
            {
              location,
              tool: named.tool,
              value: `file ${String(versionFile.value)}`,
              marker: undefined,
              matrix: undefined,
            },
          ];
    }
    const marker = input ? markerPattern.exec(input.text)?.[1] : undefined;
    return [
      {
        location: input ? `${file}:${input.line} ${step.location.split(" ")[1]}` : step.location,
        tool: named.tool,
        value: input ? String(input.value) : "none",
        marker,
        matrix: step.matrix,
      },
    ];
  });
}

const supportLists = (
  JSON.parse(await readFile(path.join(repository, "support.json"), "utf8")) as {
    support: Record<string, { tested?: readonly (string | number)[] }>;
  }
).support;
const pins = await readPins(repository);

/** Each version that is neither a correct pin nor a support-matrix version, with its location. */
function pinViolations(versions: readonly ToolVersion[]): string[] {
  return versions.flatMap(({ location, tool, value, marker, matrix }) => {
    const pinned = pins.get(tool);
    if (marker !== undefined) {
      if (marker !== tool) return [`${location} ${tool} ${value} is marked as the ${marker} pin`];
      if (value !== pinned) return [`${location} ${tool} ${value}, but mise.toml pins ${pinned}`];
      return [];
    }
    if (readsPlanMatrix(value, tool, matrix)) return [];
    if (value.startsWith("${{"))
      return [`${location} ${tool} ${value} is not a support.json matrix`];
    if (value.startsWith("file ")) return [`${location} ${tool} reads the version ${value}`];
    const tested = (supportLists[tool]?.tested ?? []).map(String);
    if (tested.includes(value)) return [];
    if (value === "none") return [`${location} ${tool} names no version`];
    return [
      `${location} ${tool} ${value} has no mise.toml marker and is not a support.json version`,
    ];
  });
}

const workflows = await Promise.all(
  (await readdir(workflowDirectory))
    .filter((file) => /\.ya?ml$/.test(file))
    .toSorted()
    .map(async (file) => ({
      file,
      versions: toolVersions(file, await readFile(path.join(workflowDirectory, file), "utf8")),
    })),
);
const allVersions = workflows.flatMap(({ versions }) => versions);

describe("the workflow tool pins", () => {
  it("reads every workflow", () => {
    expect(workflows.map(({ file }) => file)).toEqual([
      "benchmark.yml",
      "ci.yml",
      "release-python.yml",
      "release.yml",
    ]);
  });

  it("names the mise.toml pin, or a support.json version, in every setup step", () => {
    expect(allVersions.length).toBeGreaterThan(0);
    expect(pinViolations(allVersions)).toEqual([]);
  });

  // A release builds what registries receive, so it uses the pins that local checks use, and no
  // support-matrix version, for each tool that mise.toml pins exactly.
  it("builds each release with the mise.toml pins", () => {
    const release = allVersions.filter(
      ({ location, tool }) => location.startsWith("release") && tool !== "node",
    );
    expect(release.map(({ location, tool }) => `${location.split(":")[0]} ${tool}`)).toEqual([
      "release-python.yml uv",
      "release-python.yml uv",
      "release-python.yml uv",
      "release.yml gradle",
      "release.yml rust",
      "release.yml ruby",
      "release.yml java",
      "release.yml rust",
      "release.yml ruby",
      "release.yml gradle",
      "release.yml java",
      "release.yml dotnet",
    ]);
    expect(release.filter(({ tool, marker }) => marker !== tool)).toEqual([]);
  });

  it("reads the Go version from a go.mod toolchain line that names the mise.toml pin", async () => {
    const goMod = await readFile(path.join(repository, "go/go.mod"), "utf8");
    expect(/^toolchain go(\S+)$/m.exec(goMod)?.[1]).toBe(pins.get("go"));
  });

  it("fails a drifted pin in a later step of a job, with its location", () => {
    const source = [
      "jobs:",
      "  maven-central:",
      "    steps:",
      "      - uses: actions/setup-java@v6",
      "        with:",
      "          distribution: temurin",
      `          java-version: ${pins.get("java")} # Pinned to the java version in mise.toml.`,
      "      - uses: actions/setup-java@v6",
      "        with:",
      "          java-version: 25.0.3 # Pinned to the java version in mise.toml.",
      "  crates-io:",
      "    steps:",
      "      - uses: actions-rust-lang/setup-rust-toolchain@v1",
      "        with:",
      "          toolchain: 1.88.0",
      "  rubygems:",
      "    steps:",
      "      - uses: ruby/setup-ruby@v1",
      "        with:",
      "          ruby-version: 3.4.10 # Pinned to the ruby version in mise.toml.",
      "      - uses: ruby/setup-ruby@v1",
      "        with:",
      "          ruby-version: 3.4 # Pinned to the ruby version in mise.toml.",
      "      - uses: ruby/setup-ruby@v1",
      "        with:",
      '          ruby-version: "3.4"',
      "      - uses: taiki-e/install-action@v2",
      "        with:",
      "          tool: cargo-deny@0.19.0 # Pinned to the cargo-deny version in mise.toml.",
      "      - uses: gradle/actions/setup-gradle@v6",
      "        with:",
      `          gradle-version: ${pins.get("gradle")} # Pinned to the rust version in mise.toml.`,
      "  matrix:",
      "    strategy:",
      "      matrix:",
      "        java: ['25.0.3']",
      "    steps:",
      "      - uses: actions/setup-java@v6",
      "        with:",
      "          java-version: ${{ matrix.java }}",
      "      - uses: actions/setup-java@v6",
      "        with:",
      "          java-version: ${{ '25.0.3' }}",
      "      - uses: actions/setup-java@v6",
      "        with:",
      "          java-version-file: .java-version",
      "      - uses: actions/setup-java@v6",
      "        with:",
      "          java-version: ${{ fromJSON(needs.plan.outputs.jvm).include[0].java }}",
      "  planned:",
      "    strategy:",
      "      matrix: ${{ fromJSON(needs.plan.outputs.jvm) }}",
      "    steps:",
      "      - uses: actions/setup-java@v6",
      "        with:",
      "          java-version: ${{ matrix.java }}",
      "      - uses: actions/setup-go@v6",
      "        with:",
      "          go-version-file: go/go.mod",
      "      - uses: actions/setup-go@v6",
      "        with:",
      "          go-version-file: tools/go.mod",
    ].join("\n");

    expect(pinViolations(toolVersions("release.yml", source))).toEqual([
      `release.yml:10 maven-central[1] java 25.0.3, but mise.toml pins ${pins.get("java")}`,
      "release.yml:15 crates-io[0] rust 1.88.0 has no mise.toml marker and is not a support.json version",
      `release.yml:20 rubygems[0] ruby 3.4.10, but mise.toml pins ${pins.get("ruby")}`,
      `release.yml:23 rubygems[1] ruby 3.4, but mise.toml pins ${pins.get("ruby")}`,
      `release.yml:29 rubygems[3] cargo-deny 0.19.0, but mise.toml pins ${pins.get("cargo-deny")}`,
      `release.yml:32 rubygems[4] gradle ${pins.get("gradle")} is marked as the rust pin`,
      "release.yml:40 matrix[0] java ${{ matrix.java }} is not a support.json matrix",
      "release.yml:43 matrix[1] java ${{ '25.0.3' }} is not a support.json matrix",
      "release.yml:46 matrix[2] java reads the version file .java-version",
      "release.yml:62 planned[2] go reads the version file tools/go.mod",
    ]);
  });
});
