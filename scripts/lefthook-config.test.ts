import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const config = await readFile(path.resolve(import.meta.dirname, "../lefthook.yml"), "utf8");

describe("lefthook Rust and generated-artifact routing", () => {
  it("routes staged Rust files to the pinned formatter", () => {
    expect(config).toContain(
      'glob: "{rust/**/*.rs,rust/Cargo.toml,rust/Cargo.lock,rustfmt.toml,rust/rust-toolchain.toml}"',
    );
    expect(config).toContain("run: mise exec -- pnpm rust:format:check");
    expect(config).toContain('glob: "{rust/**/*.rs,rust/Cargo.toml,rust/Cargo.lock}"');
    expect(config).toContain("run: mise exec -- pnpm rust:test");
    expect(config).toContain('glob: "**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,yml,yaml}"');
  });

  it("routes Rust and generated parity files to their checks", () => {
    expect(config).toContain(
      'glob: "{rust/**,rust/PARITY.md,typescript/core/test/support/parity-capabilities.ts,docs/parity.md,scripts/generate-parity-tables.ts}"',
    );
    expect(config).toContain(
      'glob: "{rust/**,rust/PARITY.md,docs/rust-conformance.md,scripts/generate-rust-conformance.ts}"',
    );
    expect(config).toContain("run: mise exec -- pnpm parity:check");
    expect(config).toContain("run: mise exec -- pnpm rust:conformance:check");
  });
});
