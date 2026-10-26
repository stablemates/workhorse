import { describe, expect, it } from "vitest";
import { corePackage, publishedPackages } from "./packages.js";
import {
  connectionString,
  consumerNugetConfig,
  consumerVersionLine,
  pythonProvenanceProblems,
  render,
  verificationSteps,
} from "./verify-release.js";

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
    // Publication order puts core's dependencies first, so the consumer names core, which carries
    // the `workhorse` CLI, instead of the first package published.
    expect(steps.find((step) => step.args[0] === "install")?.args).toEqual([
      "install",
      `${(await corePackage()).name}@1.2.3`,
    ]);
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

  it("runs a task in the Java and Kotlin consumers from Maven Central for the cold install", async () => {
    const steps = await verificationSteps(
      "maven",
      "1.2.3",
      {},
      {
        WORKHORSE_VERIFY_DATABASE_URL: "postgres://user:secret@db:5432/app",
      },
    );
    const builds = steps.filter((step) => step.command === "gradle");

    expect(builds.map((step) => step.args[1])).toEqual(["java", "kotlin"]);
    for (const build of builds) {
      expect(build.args).toContain("-PworkhorseVersion=1.2.3");
      expect(build.args).toContain("--refresh-dependencies");
      expect(build.args).toContain(
        "--args=jdbc:postgresql://db:5432/app?user=user&password=secret",
      );
      expect(build.args.some((arg) => arg.startsWith("-PworkhorseRepository="))).toBe(false);
      expect(render(build)).toContain("password=***");
      expect(render(build)).not.toContain("secret");
    }
    // Each consumer prints its jar and the id of the task it ran and checked.
    const [java, kotlin] = builds;
    expect(
      java?.expectPattern?.test("workhorse-1.2.3.jar\n0b0e6d1e-5c1a-4d3e-9f00-1a2b3c4d5e6f"),
    ).toBe(true);
    expect(java?.expectPattern?.test("workhorse-1.2.3.jar")).toBe(false);
    expect(
      kotlin?.expectPattern?.test(
        "workhorse-kotlin-1.2.3.jar\n0b0e6d1e-5c1a-4d3e-9f00-1a2b3c4d5e6f",
      ),
    ).toBe(true);
    expect(
      kotlin?.expectPattern?.test(
        "workhorse-kotlin-1.2.4.jar\n0b0e6d1e-5c1a-4d3e-9f00-1a2b3c4d5e6f",
      ),
    ).toBe(false);
  });

  it("refuses a cold install without a database to run the task in", async () => {
    await expect(verificationSteps("maven", "1.2.3", {}, {})).rejects.toThrow(
      "The maven target needs WORKHORSE_VERIFY_DATABASE_URL",
    );
  });

  it("takes the JVM artifacts from the staging directory for the rehearsal", async () => {
    const steps = await verificationSteps(
      "maven",
      "1.2.3",
      { mavenRepo: "/staging" },
      {
        WORKHORSE_VERIFY_DATABASE_URL: "postgres://localhost/app",
      },
    );

    for (const build of steps.filter((step) => step.command === "gradle")) {
      expect(build.args).toContain("-PworkhorseRepository=/staging");
      expect(build.args).not.toContain("--refresh-dependencies");
    }
    await expect(verificationSteps("crate", "1.2.3", { mavenRepo: "/staging" })).rejects.toThrow(
      "--maven-repo applies only to the maven target",
    );
  });

  it("restores the four .NET packages from nuget.org and runs a task for the cold install", async () => {
    const steps = await verificationSteps(
      "nuget",
      "1.2.3",
      {},
      { WORKHORSE_VERIFY_DATABASE_URL: "postgres://user:secret@db:5432/app" },
    );
    const config = steps.find((step) => step.args.includes("consumer/nuget.config"));
    const restore = steps.find((step) => step.args[0] === "restore");
    const run = steps.at(-1);

    expect(config?.args.at(-1)).toBe(consumerNugetConfig());
    // An empty package folder and no HTTP cache, so a restore after a publish asks nuget.org again.
    expect(restore?.args).toEqual([
      "restore",
      "consumer/ReleaseConsumer.csproj",
      "--configfile",
      "consumer/nuget.config",
      "--packages",
      "packages",
      "--no-http-cache",
      "-p:WorkhorseVersion=1.2.3",
    ]);
    // The scratch directory is outside the checkout, so each dotnet and node step names the pins.
    for (const step of steps.filter((entry) => ["dotnet", "node"].includes(entry.command))) {
      expect(step.environment).toMatchObject({
        DOTNET_NOLOGO: "1",
        MISE_DOTNET_VERSION: expect.any(String),
        MISE_NODE_VERSION: "24.22.1",
      });
    }
    expect(
      steps.filter((step) => step.args[0] === "-p").map((step) => [step.args[1], step.expect]),
    ).toEqual(
      [
        "workhorse",
        "workhorse.hosting",
        "workhorse.entityframeworkcore",
        "workhorse.aspnetcore",
      ].map((id) => [
        `JSON.parse(require("node:fs").readFileSync("packages/${id}/1.2.3/.nupkg.metadata", "utf8")).source`,
        "https://api.nuget.org/v3/index.json",
      ]),
    );
    expect(run?.args.slice(0, 8)).toEqual([
      "run",
      "--project",
      "consumer/ReleaseConsumer.csproj",
      "--no-restore",
      "-c",
      "Release",
      "-p:WorkhorseVersion=1.2.3",
      "--",
    ]);
    expect(run?.args.at(-1)).toBe(
      "Host='db';Port='5432';Database='app';Username='user';Password='secret'",
    );
    expect(render(run!)).toContain("Password=***");
    expect(render(run!)).not.toContain("secret");
    // The consumer prints the version of each package assembly, then the id of the task it ran.
    const versions = consumerVersionLine("1.2.3");
    expect(run?.expectPattern?.test(`${versions}\n0b0e6d1e-5c1a-4d3e-9f00-1a2b3c4d5e6f`)).toBe(
      true,
    );
    expect(run?.expectPattern?.test(versions)).toBe(false);
    expect(
      run?.expectPattern?.test(
        `${consumerVersionLine("1.2.4")}\n0b0e6d1e-5c1a-4d3e-9f00-1a2b3c4d5e6f`,
      ),
    ).toBe(false);
  });

  it("refuses a .NET cold install without a database to run the task in", async () => {
    await expect(verificationSteps("nuget", "1.2.3", {}, {})).rejects.toThrow(
      "The nuget target needs WORKHORSE_VERIFY_DATABASE_URL",
    );
  });

  it("takes the four .NET packages from the local feed for the rehearsal", async () => {
    const steps = await verificationSteps(
      "nuget",
      "1.2.3",
      { nugetFeed: "/tmp/feed" },
      { WORKHORSE_VERIFY_DATABASE_URL: "postgres://localhost/app" },
    );

    expect(steps.find((step) => step.args.includes("consumer/nuget.config"))?.args.at(-1)).toBe(
      consumerNugetConfig("/tmp/feed"),
    );
    expect(steps.find((step) => step.args[0] === "restore")?.args).not.toContain("--no-http-cache");
    expect(steps.filter((step) => step.args[0] === "-p").map((step) => step.expect)).toEqual([
      "/tmp/feed",
      "/tmp/feed",
      "/tmp/feed",
      "/tmp/feed",
    ]);
    await expect(verificationSteps("maven", "1.2.3", { nugetFeed: "/tmp/feed" })).rejects.toThrow(
      "--nuget-feed applies only to the nuget target",
    );
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

describe("the .NET release consumer", () => {
  it("takes the four packages only from nuget.org, or only from the local feed", () => {
    const registry = consumerNugetConfig();
    expect(registry).toContain("<clear />");
    expect(registry).toContain(
      '<add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />',
    );
    expect(registry).not.toContain("workhorse-release");

    const config = consumerNugetConfig("/tmp/feed & co");
    expect(config).toContain("<clear />");
    expect(config).toContain('<add key="workhorse-release" value="/tmp/feed &amp; co" />');
    expect(config).toMatch(
      /<packageSource key="workhorse-release">\s*<package pattern="Workhorse" \/>\s*<package pattern="Workhorse\.\*" \/>\s*<\/packageSource>/,
    );
    expect(config).toMatch(/<packageSource key="nuget.org">\s*<package pattern="\*" \/>/);
  });

  it("expects the train version from each package assembly", () => {
    expect(consumerVersionLine("0.9.0")).toBe(
      "Workhorse=0.9.0 Workhorse.Hosting=0.9.0 Workhorse.EntityFrameworkCore=0.9.0 Workhorse.AspNetCore=0.9.0",
    );
  });

  it("passes the database to Npgsql as a quoted connection string", () => {
    expect(connectionString("postgres://work%40horse:pa'ss@localhost:5433/workhorse_test_x")).toBe(
      "Host='localhost';Port='5433';Database='workhorse_test_x';Username='work@horse';Password='pa''ss'",
    );
    expect(connectionString("postgres://localhost/workhorse_test")).toBe(
      "Host='localhost';Port='5432';Database='workhorse_test'",
    );
  });
});

describe("pythonProvenanceProblems", () => {
  const wheel = "stablemates_workhorse-1.2.3-py3-none-any.whl";
  const sdist = "stablemates_workhorse-1.2.3.tar.gz";
  const attested = {
    version: 1,
    attestation_bundles: [
      {
        publisher: {
          environment: "pypi",
          kind: "GitHub",
          repository: "stablemates/workhorse",
          workflow: "release-python.yml",
        },
        attestations: [{ version: 1 }],
      },
    ],
  };

  // Answers the PyPI JSON API with both files and each integrity URL from `provenance`.
  function pypi(provenance: Readonly<Record<string, unknown>>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://pypi.org/pypi/stablemates-workhorse/1.2.3/json") {
        return Response.json({ urls: [{ filename: wheel }, { filename: sdist }] });
      }
      const file =
        /^https:\/\/pypi\.org\/integrity\/stablemates-workhorse\/1\.2\.3\/(.+)\/provenance$/.exec(
          url,
        )?.[1];
      const body = file === undefined ? undefined : provenance[file];
      return body === undefined
        ? Response.json({ message: "No provenance available" }, { status: 404 })
        : Response.json(body);
    }) as typeof fetch;
  }

  it("passes when every file carries an attestation from the release workflow", async () => {
    await expect(
      pythonProvenanceProblems("1.2.3", pypi({ [wheel]: attested, [sdist]: attested })),
    ).resolves.toEqual([]);
  });

  // 0.6.0 reached PyPI this way: both files, and a 404 from the integrity API for each.
  it("fails for each file PyPI holds no provenance for", async () => {
    await expect(pythonProvenanceProblems("1.2.3", pypi({}))).resolves.toEqual([
      `${wheel} has no PyPI provenance (HTTP 404)`,
      `${sdist} has no PyPI provenance (HTTP 404)`,
    ]);
  });

  it("fails for an attestation from another publisher or with no attestations", async () => {
    const foreign = {
      attestation_bundles: [
        {
          ...attested.attestation_bundles[0],
          publisher: { repository: "someone/else", workflow: "release-python.yml" },
        },
      ],
    };
    const empty = {
      attestation_bundles: [{ ...attested.attestation_bundles[0], attestations: [] }],
    };

    await expect(
      pythonProvenanceProblems("1.2.3", pypi({ [wheel]: foreign, [sdist]: empty })),
    ).resolves.toEqual([
      `${wheel} has no attestation from stablemates/workhorse release-python.yml`,
      `${sdist} has no attestation from stablemates/workhorse release-python.yml`,
    ]);
  });

  it("fails when PyPI has no such release", async () => {
    await expect(pythonProvenanceProblems("9.9.9", pypi({}))).resolves.toEqual([
      "PyPI has no stablemates-workhorse 9.9.9 (HTTP 404)",
    ]);
  });
});
