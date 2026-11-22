import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every SDK writes every worker log event of the `WorkhorseLogEvent` union.
 *
 * The seven SDKs give each log event the same name (docs/parity.md, "Worker log differences"). A
 * review of a diff does not find an event that an SDK never writes, because no diff changes the
 * code that is missing. This check reads the source of each SDK and requires the name of each event
 * in it. The event lists of each SDK, such as `Names.java`, do not count, because a name in a list
 * writes no record. The check reads names only, so a constant or a comment also satisfies it. The
 * log tests of each SDK check that the record is written, with its severity and attributes.
 *
 * An event that an SDK cannot write, because the SDK has no public method for the operation, is in
 * `intendedGaps` with the reason. docs/parity.md states the same gaps.
 */

type Sdk = "typescript" | "python" | "go" | "rust" | "ruby" | "jvm" | "dotnet";

const sdks: Record<Sdk, { roots: string[]; lists: string[] }> = {
  typescript: { roots: ["typescript/core/src"], lists: ["typescript/core/src/telemetry.ts"] },
  python: { roots: ["python/src"], lists: ["python/src/workhorse/_telemetry.py"] },
  go: { roots: ["go"], lists: [] },
  rust: { roots: ["rust/src"], lists: [] },
  ruby: { roots: ["ruby/lib"], lists: [] },
  jvm: {
    roots: ["jvm/workhorse/src/main"],
    lists: ["jvm/workhorse/src/main/java/run/workhorse/internal/telemetry/Names.java"],
  },
  dotnet: { roots: ["dotnet/src"], lists: [] },
};

const sourceFile = /\.(?:ts|py|go|rs|rb|java|kt|cs)$/;
const testFile = /(?:_test\.go|\.test\.ts|\.spec\.ts|Tests?\.(?:java|kt|cs))$/;
// Go keeps its examples and tools in the module, and they write no SDK record.
const skippedDirectories = new Set([
  "examples",
  "internal",
  "testdata",
  "tests",
  "test",
  "node_modules",
]);

/**
 * The events that an SDK does not write, by design. Each one names the SDKs and the reason. A
 * reason must be a missing public operation, as docs/parity.md records it.
 */
const intendedGaps: Record<string, { sdks: Sdk[]; reason: string }> = {
  "workhorse.task.run_now_requested": {
    sdks: ["python", "go", "rust", "ruby", "jvm", "dotnet"],
    reason: "Only the TypeScript SDK has Admin.runTaskNow (docs/parity.md, operator surface).",
  },
  "workhorse.retention_policy.synchronized": {
    sdks: ["python", "go", "rust", "ruby", "jvm", "dotnet"],
    reason: "Only the TypeScript SDK has the retention policy methods.",
  },
  "workhorse.maintenance_policy.synchronized": {
    sdks: ["python", "go", "rust", "ruby", "jvm", "dotnet"],
    reason: "Only the TypeScript SDK has the maintenance policy methods.",
  },
  "workhorse.cold_export_policy.synchronized": {
    sdks: ["python", "go", "rust", "ruby", "jvm", "dotnet"],
    reason: "Only the TypeScript SDK has the cold export methods.",
  },
  "workhorse.tasks.promoted": {
    sdks: ["python", "go", "rust", "ruby", "jvm", "dotnet"],
    reason:
      "Only the TypeScript SDK has Queue.promote. The other workers promote through tick_v1, which maintenance.completed records.",
  },
  "workhorse.worker_registry.pruned": {
    sdks: ["python", "go", "rust", "ruby", "jvm", "dotnet"],
    reason: "Only the TypeScript SDK has Queue.pruneWorkerRegistry.",
  },
};

async function sources(directory: string, lists: Set<string>): Promise<string[]> {
  const texts: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) texts.push(...(await sources(file, lists)));
    } else if (sourceFile.test(entry.name) && !testFile.test(entry.name) && !lists.has(file)) {
      texts.push(await readFile(file, "utf8"));
    }
  }
  return texts;
}

async function logEvents(): Promise<string[]> {
  const telemetry = await readFile("typescript/core/src/telemetry.ts", "utf8");
  const union = /export type WorkhorseLogEvent\s*=([^;]+);/.exec(telemetry)?.[1] ?? "";
  return [...union.matchAll(/"(workhorse\.[a-z_.]+)"/g)].map((match) => match[1]!).toSorted();
}

/** The events that each SDK does not write and that `intendedGaps` does not explain. */
export async function missingLogEvents(): Promise<Record<Sdk, string[]>> {
  const events = await logEvents();
  const missing = {} as Record<Sdk, string[]>;
  for (const [sdk, { roots, lists }] of Object.entries(sdks) as [Sdk, (typeof sdks)[Sdk]][]) {
    const texts = (await Promise.all(roots.map((root) => sources(root, new Set(lists))))).flat();
    missing[sdk] = events.filter(
      (event) =>
        !intendedGaps[event]?.sdks.includes(sdk) &&
        !texts.some((text) => text.includes(`"${event}"`) || text.includes(`'${event}'`)),
    );
  }
  return missing;
}

describe("worker log event parity", () => {
  it("reads the events of the TypeScript union", async () => {
    const events = await logEvents();
    expect(events.length).toBeGreaterThan(50);
    expect(events).toContain("workhorse.worker.registered");
  });

  it("writes every event in every SDK, apart from the intended gaps", async () => {
    const missing = await missingLogEvents();
    expect(missing).toEqual({
      typescript: [],
      python: [],
      go: [],
      rust: [],
      ruby: [],
      jvm: [],
      dotnet: [],
    });
  });

  it("documents every event in docs/architecture/telemetry.md", async () => {
    const telemetry = await readFile("docs/architecture/telemetry.md", "utf8");
    const start = telemetry.indexOf("#### Severity coverage");
    const end = telemetry.indexOf("#### Log record attributes");
    const section = telemetry.substring(start, end);
    expect(start).toBeGreaterThan(-1);
    expect((await logEvents()).filter((event) => !section.includes(`\`${event}\``))).toEqual([]);
  });

  it("names an event of the union in each intended gap", async () => {
    const events = new Set(await logEvents());
    for (const event of Object.keys(intendedGaps)) expect(events).toContain(event);
  });
});
