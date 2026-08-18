import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WORKHORSE_VERSION } from "../src/version.js";

describe("Workhorse package version", () => {
  it("matches the core release manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(WORKHORSE_VERSION).toBe(manifest.version);
  });
});
