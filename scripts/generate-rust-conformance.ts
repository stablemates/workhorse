import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "docs/rust-conformance.md");
const check = process.argv.includes("--check");

async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, "protocol/v1", name), "utf8"));
}

const manifest = (await json("manifest.json")) as {
  protocolVersion: number;
  fixtureCoverage: Record<string, string[]>;
  runtimeCoverage: string[];
};
const files = [
  "compatibility",
  "contracts",
  "cron-occurrences",
  "failures",
  "interpreter",
  "requests",
  "runtime",
  "scenarios",
  "schedules",
] as const;
const counts = await Promise.all(
  files.map(async (name) => {
    const value = await json(`${name}.json`);
    return [
      name,
      Array.isArray(value)
        ? value.length
        : ((value as { fixtures?: unknown[] }).fixtures?.length ?? 1),
    ] as const;
  }),
);
const rows = counts.map(([name, count]) => [`\`${name}.json\``, String(count)] as const);
const fixtureWidth = Math.max("Fixture".length, ...rows.map(([name]) => name.length));
const entryWidth = Math.max("Entries".length, ...rows.map(([, count]) => count.length));
const table = [
  `| ${"Fixture".padEnd(fixtureWidth)} | ${"Entries".padStart(entryWidth)} |`,
  `| ${"-".repeat(fixtureWidth)} | ${":".padStart(entryWidth, "-")} |`,
  ...rows.map(
    ([name, count]) => `| ${name.padEnd(fixtureWidth)} | ${count.padStart(entryWidth)} |`,
  ),
].join("\n");
const body = `# Rust conformance evidence\n\nGenerated from \`protocol/v1\` at protocol version ${manifest.protocolVersion}. The harness currently proves fixture loading, manifest coverage, and fixture shape. Runtime execution awaits the SDK seams owned by SM-16A, SM-16B, and SM-16C.\n\n## Generated fixture inventory\n\n${table}\n\nThe manifest declares ${manifest.runtimeCoverage.length} runtime capabilities and ${Object.values(manifest.fixtureCoverage).flat().length} language fixture identifiers. Once the client, worker, and durable context crates land, their adapters must execute these same files without copying them.\n\nRegenerate with \`pnpm rust:conformance:generate\`; CI uses \`pnpm rust:conformance:check\`.\n`;
if (check) {
  const current = await readFile(output, "utf8");
  if (current !== body)
    throw new Error("docs/rust-conformance.md is stale; run pnpm rust:conformance:generate");
} else {
  await writeFile(output, body);
}
