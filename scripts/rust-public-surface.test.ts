import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./packages.js";

// ADR 0079 governs every public item that the `workhorse` crate root reaches, and every published
// feature. An item that `#[doc(hidden)]` hides from the documentation is still public, and a feature
// whose name starts with `__` is still published. A 0.x release took both kinds out of the crate
// (SM-2037). This check keeps them out: a test that needs crate state compiles inside the crate
// (`rust/tests/crate_private`).
//
// After 1.0.0 the crate can only add. A record with public fields or an enum that is closed cannot
// gain a field or a variant without a break, so each one is `#[non_exhaustive]` or stays on
// `closedTypes` with its reason (SM-2038, ADR 0074). The check reads `api/rust.txt`, which lists
// every public item under each feature.

const crateRoot = path.join(repositoryRoot, "rust");

/** Each hidden item in the crate source that the governed surface still holds on purpose. */
const keptHiddenItems: readonly { file: string; item: string; reason: string }[] = [
  {
    file: "src/error.rs",
    item: "Suspended,",
    reason:
      "ADR 0074: a durable wait returns it and a handler propagates it, so the variant is public",
  },
];

/** The public records and enums that stay closed, with the reason that a later release keeps them so. */
const closedTypes: readonly { name: string; reason: string }[] = [
  { name: "workhorse::AdminAudit", reason: "the audit triple of each operator action is complete" },
  { name: "workhorse::BatchResult", reason: "a batch handler builds it to report its tasks" },
  {
    name: "workhorse::DebounceSchedule",
    reason: "an input that a caller builds and the crate reads",
  },
  {
    name: "workhorse::DependencyTerminalPolicy",
    reason: "an input that a caller builds and the crate reads",
  },
  {
    name: "workhorse::ScheduleCatchupPolicy",
    reason: "an input that a caller builds and the crate reads",
  },
  { name: "workhorse::policies::RateLimit", reason: "a rate is complete with its three numbers" },
  {
    name: "workhorse::dashboard::Authorization",
    reason: "the authorize callback of a host builds it to allow or refuse a request",
  },
  {
    name: "workhorse::dashboard::Principal",
    reason: "the authorize callback of a host builds it for the signed-in operator",
  },
];

/**
 * Each public record with a public field, and each public enum, in the lines of a snapshot. A named
 * field has a line of its own, and a tuple field is part of the line of its record.
 */
function governedTypes(lines: readonly string[]): { name: string; nonExhaustive: boolean }[] {
  const cfg = String.raw`(?:#\[cfg\(feature = "\w+"\)\] )?`;
  const declaration = new RegExp(
    String.raw`^${cfg}(#\[non_exhaustive\] )?pub (struct|enum) (workhorse::[\w:]+)`,
  );
  const field = new RegExp(String.raw`^${cfg}pub (workhorse::[\w:]+)::\w+: `);
  const withFields = new Set(lines.flatMap((line) => field.exec(line)?.[1] ?? []));
  return lines.flatMap((line) => {
    const match = declaration.exec(line);
    if (match === null) return [];
    const [, attribute, kind, name = ""] = match;
    const tupleFields = /\((?:.*, )?pub /.test(line.slice(match[0].length));
    if (kind === "struct" && !withFields.has(name) && !tupleFields) return [];
    return [{ name, nonExhaustive: attribute !== undefined }];
  });
}

function rustFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return rustFiles(full);
    return entry.name.endsWith(".rs") ? [full] : [];
  });
}

/** The first line after each `#[doc(hidden)]` that is not an attribute or a comment, by file. */
function hiddenItems(): { file: string; item: string }[] {
  return rustFiles(path.join(crateRoot, "src")).flatMap((file) => {
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim());
    return lines.flatMap((line, index) => {
      if (line !== "#[doc(hidden)]") return [];
      const item = lines
        .slice(index + 1)
        .find((next) => !next.startsWith("#[") && !next.startsWith("//"));
      return [{ file: path.relative(crateRoot, file), item: item ?? "" }];
    });
  });
}

/** The feature names that `rust/Cargo.toml` declares. */
function features(): string[] {
  const manifest = readFileSync(path.join(crateRoot, "Cargo.toml"), "utf8");
  const section = /^\[features\]\n([\s\S]*?)(?=^\[)/m.exec(manifest)?.[1] ?? "";
  return [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map(([, name]) => name ?? "");
}

describe("the published Rust crate", () => {
  it("hides no public item from its documentation", () => {
    const unexpected = hiddenItems().filter(
      (found) =>
        !keptHiddenItems.some((kept) => kept.file === found.file && kept.item === found.item),
    );
    expect(unexpected).toEqual([]);
  });

  it("names no public item as a test hook", () => {
    const hooks = rustFiles(path.join(crateRoot, "src")).flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /\bpub\s+(?:const\s+|async\s+)*fn\s+(\w+_for_test)\b/g,
        ),
      ].map(([, name]) => `${path.relative(crateRoot, file)}: ${name ?? ""}`),
    );
    expect(hooks).toEqual([]);
  });

  it("keeps each listed hidden item, so the list cannot go stale", () => {
    const found = hiddenItems();
    const stale = keptHiddenItems.filter(
      (kept) => !found.some((item) => item.file === kept.file && item.item === kept.item),
    );
    expect(stale).toEqual([]);
  });

  it("opens each public record and enum to additions, or lists why it stays closed", () => {
    const snapshot = readFileSync(path.join(repositoryRoot, "api/rust.txt"), "utf8");
    const types = governedTypes(snapshot.split("\n"));
    expect(types.length).toBeGreaterThan(100);
    const closed = types.filter((type) => !type.nonExhaustive).map((type) => type.name);
    expect(closed.toSorted()).toEqual(closedTypes.map((type) => type.name).toSorted());
  });

  it("reads a record with public tuple fields as governed", () => {
    expect(
      governedTypes([
        "pub struct workhorse::Opaque(_)",
        "pub struct workhorse::Pair(pub i32, pub i32)",
        "pub struct workhorse::Mixed(_, pub i32)",
        "#[non_exhaustive] pub struct workhorse::Open(pub i32)",
      ]),
    ).toEqual([
      { name: "workhorse::Pair", nonExhaustive: false },
      { name: "workhorse::Mixed", nonExhaustive: false },
      { name: "workhorse::Open", nonExhaustive: true },
    ]);
  });

  it("publishes no feature whose name starts with __", () => {
    const declared = features();
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => name.startsWith("__"))).toEqual([]);
  });
});
