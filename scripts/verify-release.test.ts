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

  it("installs every packed tarball instead of the npm release for the rehearsal", async () => {
    const packages = await publishedPackages();
    const steps = await verificationSteps("npm", "1.2.3", { tarballs: "/dist" });

    expect(steps.some((step) => step.args[0] === "view" || step.args[0] === "audit")).toBe(false);
    expect(steps.find((step) => step.args[0] === "install")?.args.slice(2)).toEqual(
      packages.map((entry) => `/dist/${entry.tarball}`),
    );
    expect(steps.filter((step) => step.expect === "1.2.3")).toHaveLength(packages.length + 1);
  });

  it("depends on the unpacked archive by path for the crate rehearsal", async () => {
    const steps = await verificationSteps("crate", "1.2.3", { crate: "/tmp/workhorse-1.2.3" });

    expect(steps[1]?.args).toEqual(["add", "workhorse", "--path", "/tmp/workhorse-1.2.3"]);
    expect(steps.at(-1)?.expect).toBe("path+file:///tmp/workhorse-1.2.3#workhorse@1.2.3");
  });

  it("serves a staged proxy ahead of proxy.golang.org for the Go rehearsal", async () => {
    const steps = await verificationSteps("go", "1.2.3", { goProxy: "/tmp/proxy" });

    expect(steps.map((step) => step.environment)).toEqual(
      steps.map(() => ({
        GOFLAGS: "-mod=mod -modcacherw",
        GOMODCACHE: "/tmp/proxy/.modcache",
        GONOSUMDB: "github.com/stablemates/workhorse/go",
        GOPROXY: "file:///tmp/proxy,https://proxy.golang.org",
        GOWORK: "off",
      })),
    );
  });

  it("rejects an artifact that belongs to another target", async () => {
    await expect(verificationSteps("go", "1.2.3", { crate: "/tmp/c" })).rejects.toThrow(
      "--crate applies only to the crate target",
    );
    await expect(verificationSteps("python", "1.2.3", { tarballs: "/dist" })).rejects.toThrow(
      "--tarballs applies only to the npm target",
    );
    await expect(verificationSteps("npm", "1.2.3", { goProxy: "/tmp/p" })).rejects.toThrow(
      "--go-proxy applies only to the go target",
    );
  });
});
