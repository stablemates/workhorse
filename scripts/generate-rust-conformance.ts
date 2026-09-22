import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readRustFixtureState } from "./rust-parity-evidence.js";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "docs/rust-conformance.md");
const check = process.argv.includes("--check");

const manifest = JSON.parse(
  await readFile(path.join(root, "protocol/v1/manifest.json"), "utf8"),
) as { protocolVersion: number };
const state = readRustFixtureState(root);

function category(fixture: string): string {
  return fixture.slice(0, fixture.indexOf("/"));
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join(" | ")} |`;
  const rule = `| ${widths.map((width, column) => (column === 0 ? "-".repeat(width) : `${"-".repeat(width - 1)}:`)).join(" | ")} |`;
  return [line(header), rule, ...rows.map(line)].join("\n");
}

const categories = [...new Set([...state.declared].map(category))].toSorted();
const inventory = table(
  ["Fixture file", "Declared", "Passing", "Expected unsupported"],
  categories.map((name) => {
    const declared = [...state.declared].filter((fixture) => category(fixture) === name).length;
    const listed = [...state.unsupported.keys()].filter(
      (fixture) => category(fixture) === name,
    ).length;
    return [`\`${name}.json\``, String(declared), String(declared - listed), String(listed)];
  }),
);

const byIssue = new Map<string, string[]>();
for (const [fixture, issue] of state.unsupported) {
  byIssue.set(issue, [...(byIssue.get(issue) ?? []), fixture]);
}
const gaps = [...byIssue]
  .toSorted(([left], [right]) => left.localeCompare(right, "en", { numeric: true }))
  .map(
    ([issue, fixtures]) =>
      `### ${issue}\n\n${fixtures
        .toSorted()
        .map((fixture) => `- \`${fixture}\``)
        .join("\n")}`,
  )
  .join("\n\n");

const body = `# Rust conformance evidence

Generated from \`protocol/v1\` at protocol version ${manifest.protocolVersion} and from
\`rust/tests/conformance/expected-unsupported.json\`.

\`rust/tests/protocol_conformance.rs\` executes every \`protocol/v1\` fixture through the Rust
adapters against a scratch PostgreSQL database. A fixture either passes or appears on the
expected-unsupported list with the Issue that owns the gap. The runner fails when an unlisted
fixture does not pass, and when a listed fixture passes. \`pnpm rust:integration\` runs it in CI.

## Fixture inventory

${inventory}

## Expected unsupported fixtures

The list gives the reason for each entry. Remove an entry in the commit that makes it pass.

${gaps}

Regenerate with \`pnpm rust:conformance:generate\`; CI uses \`pnpm rust:conformance:check\`.
`;
if (check) {
  const current = await readFile(output, "utf8");
  if (current !== body)
    throw new Error("docs/rust-conformance.md is stale; run pnpm rust:conformance:generate");
} else {
  await writeFile(output, body);
}
