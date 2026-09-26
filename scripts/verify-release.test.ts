import { describe, expect, it } from "vitest";
import { publishedPackages } from "./packages.js";
import { verificationSteps } from "./verify-release.js";

describe("verificationSteps", () => {
  it("checks the public Python version attribute and the distribution metadata", async () => {
    const steps = await verificationSteps("python", "1.2.3");

    expect(steps[1]?.args.at(-1)).toBe("stablemates-workhorse==1.2.3");
    expect(steps.filter((step) => step.expect === "1.2.3").map((step) => step.args)).toEqual([
      ["-c", "import workhorse; print(workhorse.__version__)"],
      [
        "-c",
        'import importlib.metadata; print(importlib.metadata.version("stablemates-workhorse"))',
      ],
    ]);
  });

  it("installs a named wheel instead of the PyPI release for the rehearsal", async () => {
    const steps = await verificationSteps("python", "1.2.3", { wheel: "/dist/a.whl" });

    expect(steps[1]?.args.at(-1)).toBe("/dist/a.whl");
    await expect(verificationSteps("npm", "1.2.3", { wheel: "/dist/a.whl" })).rejects.toThrow(
      "--wheel applies only to the python target",
    );
  });

  it("asks the npm registry for every published package at the release version", async () => {
    const steps = await verificationSteps("npm", "1.2.3");
    const viewed = steps.filter((step) => step.args[0] === "view").map((step) => step.args[1]);

    expect(viewed).toEqual((await publishedPackages()).map((entry) => `${entry.name}@1.2.3`));
    expect(steps.at(-1)).toMatchObject({
      args: ["--no-install", "workhorse", "--version"],
      expect: "1.2.3",
    });
  });

  it("resolves the crate and the Go module from their public registries", async () => {
    expect((await verificationSteps("crate", "1.2.3")).at(-1)?.expect).toBe(
      "registry+https://github.com/rust-lang/crates.io-index#workhorse@1.2.3",
    );
    const go = await verificationSteps("go", "1.2.3");
    expect(go[0]).toMatchObject({
      args: ["list", "-m", "github.com/stablemates/workhorse/go@v1.2.3"],
      environment: { GOPROXY: "https://proxy.golang.org" },
      expect: "github.com/stablemates/workhorse/go v1.2.3",
    });
  });
});
