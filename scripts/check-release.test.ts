import { describe, expect, it } from "vitest";
import { checkRelease } from "./check-release.js";

describe("checkRelease", () => {
  it("accepts the lockstep npm package versions when the root changelog documents them", async () => {
    await expect(checkRelease("npm", "v0.1.0-beta.2")).resolves.toBeUndefined();
  });

  it("rejects an npm tag that disagrees with the package manifests", async () => {
    await expect(checkRelease("npm", "v9.9.9")).rejects.toThrow(
      "typescript/core/package.json is 0.1.0-beta.2 but the tag is 9.9.9",
    );
  });

  it("accepts the Python manifest version when its changelog documents the release", async () => {
    await expect(checkRelease("python", "python/v0.1.0b3")).resolves.toBeUndefined();
  });

  it("rejects a Python tag that disagrees with the package manifest", async () => {
    await expect(checkRelease("python", "python/v9.9.9")).rejects.toThrow(
      "python/pyproject.toml is 0.1.0b3 but the tag is 9.9.9",
    );
  });

  it("accepts a Go module tag when its changelog documents the release", async () => {
    await expect(checkRelease("go", "go/v0.1.0-beta.1")).resolves.toBeUndefined();
  });

  it("rejects malformed and undocumented Go module tags", async () => {
    await expect(checkRelease("go", "v0.1.0")).rejects.toThrow("Expected a go/vX.Y.Z release tag");
    await expect(checkRelease("go", "go/v9.9.9")).rejects.toThrow(
      "go/CHANGELOG.md has no 9.9.9 release entry",
    );
  });
});
