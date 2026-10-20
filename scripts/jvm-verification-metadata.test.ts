import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { componentDifference, withHeader } from "./jvm-verification-metadata.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

describe("the JVM verification metadata", () => {
  it("puts the header after the XML declaration", () => {
    const written = withHeader('<?xml version="1.0"?>\n<verification-metadata/>\n');
    expect(written.startsWith('<?xml version="1.0"?>\n<!--\n')).toBe(true);
    expect(written.endsWith("-->\n<verification-metadata/>\n")).toBe(true);
    expect(() => withHeader("<verification-metadata/>\n")).toThrow(/no XML declaration/);
  });

  it("names the components that only one file has", () => {
    const committed =
      '<component group="a" name="x" version="1">\n<component group="b" name="y" version="1">';
    const current =
      '<component group="a" name="x" version="1">\n<component group="b" name="y" version="2">';
    expect(componentDifference(committed, current)).toEqual({
      missing: ['<component group="b" name="y" version="2">'],
      stale: ['<component group="b" name="y" version="1">'],
    });
  });

  // A pgp trusted key accepts every version of its group with no checksum, so a dependency update
  // would pass with no change to the file.
  it("gates every artifact on a sha256 checksum and trusts no key", async () => {
    const metadata = await read("jvm/gradle/verification-metadata.xml");
    expect(metadata).toContain("<verify-metadata>true</verify-metadata>");
    expect(metadata).toContain("<verify-signatures>false</verify-signatures>");
    expect(metadata).not.toMatch(/<trusted-key|<pgp |<trusted-artifacts|<ignored-key/);
    const artifacts = metadata.match(/<artifact name="[^"]+">\s*<[a-z0-9]+ /g) ?? [];
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) expect(artifact).toMatch(/<sha256 $/);
  });

  // The snapshot lane skips verification for two test class paths. The build that holds the signing
  // key must verify every artifact, and `stageRelease` also refuses the property.
  it("keeps the release stage out of the Spring Boot snapshot lane", async () => {
    for (const file of [".github/workflows/release.yml", "scripts/check-jvm-release.ts"]) {
      expect(await read(file)).not.toContain("workhorse.springBoot");
    }
    expect(await read("jvm/build.gradle.kts")).toContain(
      'throw GradleException("stageRelease refuses -Pworkhorse.springBoot=snapshot")',
    );
  });
});
