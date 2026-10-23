import { readFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  compareVersions,
  connectionString,
  consumerNugetConfig,
  consumerVersionLine,
  dotnetTrainVersion,
  nuspecProblems,
  packageBaseline,
  packageContentProblems,
  packageFileProblems,
  publishedPackages,
  readZip,
  scratchDatabaseName,
  symbolProblems,
} from "./check-dotnet-release.js";
import { classifyTestDatabase, testFamilyRoots } from "./test-database-sweep.js";

const root = path.resolve(import.meta.dirname, "..");
const commit = "bf4b884c4ea870100c859095de27a819e00d06c6";

function nuspec(id: string, version: string, dependencies = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>${id}</id>
    <version>${version}</version>
    <authors>Stablemates</authors>
    <license type="expression">Apache-2.0</license>
    <licenseUrl>https://licenses.nuget.org/Apache-2.0</licenseUrl>
    <readme>README.md</readme>
    <projectUrl>https://workhorse.run/</projectUrl>
    <description>A package.</description>
    <repository type="git" url="https://github.com/stablemates/workhorse" commit="${commit}" />
    <dependencies>
      <group targetFramework="net10.0">${dependencies}
        <dependency id="Npgsql" version="10.0.3" exclude="Build,Analyzers" />
      </group>
    </dependencies>
  </metadata>
</package>`;
}

/** A zip archive with one stored entry and one deflated entry. */
function zip(files: Readonly<Record<string, string>>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], index) => {
    const method = index % 2 === 0 ? 0 : 8;
    const raw = Buffer.from(text);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("the .NET train version", () => {
  it("reads the version that dotnet/Directory.Build.props sets for every package", async () => {
    const props = await readFile(path.join(root, "dotnet", "Directory.Build.props"), "utf8");
    expect(dotnetTrainVersion(props)).toMatch(/^\d+\.\d+\.\d+/);
    expect(dotnetTrainVersion("<Project><Version> 1.0.0-rc.1 </Version></Project>")).toBe(
      "1.0.0-rc.1",
    );
    expect(() => dotnetTrainVersion("<Project />")).toThrow("declares no Version");
  });

  it("packs nothing but the four packages of ADR 0107", async () => {
    expect(publishedPackages).toEqual([
      "Workhorse",
      "Workhorse.Hosting",
      "Workhorse.EntityFrameworkCore",
      "Workhorse.AspNetCore",
    ]);
    // Each other project sets IsPackable to false, so `dotnet pack` of the solution skips it.
    for (const project of [
      "demo/Workhorse.DemoWorker/Workhorse.DemoWorker.csproj",
      "tools/Workhorse.ApiSnapshot/Workhorse.ApiSnapshot.csproj",
      "tests/Workhorse.Tests/Workhorse.Tests.csproj",
      "tests/Workhorse.AspNetCore.Tests/Workhorse.AspNetCore.Tests.csproj",
      "floor-consumer/FloorConsumer.csproj",
      "release-consumer/ReleaseConsumer.csproj",
    ]) {
      expect(await readFile(path.join(root, "dotnet", project), "utf8")).toContain(
        "<IsPackable>false</IsPackable>",
      );
    }
  });
});

describe("versions and the package validation baseline", () => {
  it("orders versions as SemVer 2.0 does", () => {
    const ordered = ["0.9.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta.2", "1.0.0-beta.11"];
    ordered.push("1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0");
    expect(ordered.toReversed().toSorted(compareVersions)).toEqual(ordered);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(() => compareVersions("1.0", "1.0.0")).toThrow("not a SemVer version");
  });

  it("uses no baseline before the first publish", () => {
    expect(packageBaseline(new Map(), "0.9.0")).toBeUndefined();
    // A re-run of the first release finds only the train version, which is not a baseline.
    const first = new Map(publishedPackages.map((id) => [id, ["0.9.0"]]));
    expect(packageBaseline(first, "0.9.0")).toBeUndefined();
  });

  it("uses the newest published version below the train version after the first publish", () => {
    const published = new Map(
      publishedPackages.map((id) => [id, ["0.9.0", "1.0.0-rc.1", "1.0.0", "1.1.0"]]),
    );
    expect(packageBaseline(published, "1.1.0")).toBe("1.0.0");
    expect(packageBaseline(published, "1.0.0")).toBe("1.0.0-rc.1");
  });

  it("refuses packages whose newest published versions differ", () => {
    const published = new Map(publishedPackages.map((id) => [id, ["1.0.0"]]));
    published.set("Workhorse.AspNetCore", []);
    expect(() => packageBaseline(published, "1.1.0")).toThrow(
      "Workhorse 1.0.0, Workhorse.Hosting 1.0.0, Workhorse.EntityFrameworkCore 1.0.0, Workhorse.AspNetCore none",
    );
  });
});

describe("the packed files", () => {
  const all = publishedPackages.flatMap((id) => [`${id}.0.9.0.nupkg`, `${id}.0.9.0.snupkg`]);

  it("accepts the four packages and their symbol packages at the train version", () => {
    expect(packageFileProblems(all, "0.9.0")).toEqual([]);
  });

  it("refuses a missing symbol package, another version, and another project", () => {
    const files = [
      ...all.filter((file) => file !== "Workhorse.Hosting.0.9.0.snupkg"),
      "Workhorse.DemoWorker.0.9.0.nupkg",
    ];
    expect(packageFileProblems(files, "0.9.0")).toEqual([
      "Workhorse.Hosting.0.9.0.snupkg is missing",
      "Workhorse.DemoWorker.0.9.0.nupkg is not a file of the four packages at 0.9.0",
    ]);
    expect(packageFileProblems(all, "0.9.1")).toHaveLength(16);
  });

  it("reads stored and deflated entries of a zip archive", () => {
    const files = readZip(zip({ "README.md": "# Workhorse", "Workhorse.nuspec": "<package />" }));
    expect([...files.keys()]).toEqual(["README.md", "Workhorse.nuspec"]);
    expect(files.get("README.md")?.toString()).toBe("# Workhorse");
    expect(files.get("Workhorse.nuspec")?.toString()).toBe("<package />");
    expect(() => readZip(Buffer.from("not a zip archive"))).toThrow("no end of central directory");
  });

  it("accepts a nuspec with the metadata and the train version on each Workhorse dependency", () => {
    const dependency = `
        <dependency id="Workhorse" version="0.9.0" exclude="Build,Analyzers" />`;
    expect(nuspecProblems("Workhorse", nuspec("Workhorse", "0.9.0"), "0.9.0", commit)).toEqual([]);
    expect(
      nuspecProblems(
        "Workhorse.Hosting",
        nuspec("Workhorse.Hosting", "0.9.0", dependency),
        "0.9.0",
        commit,
      ),
    ).toEqual([]);
  });

  it("refuses a nuspec with another version, license, commit, or dependency version", () => {
    const text = nuspec(
      "Workhorse.Hosting",
      "0.9.1",
      `
        <dependency id="Workhorse" version="0.8.0" exclude="Build,Analyzers" />
        <dependency id="Workhorse.Extra" version="0.9.0" exclude="Build,Analyzers" />`,
    )
      .replace("Apache-2.0</license>", "MIT</license>")
      .replace('targetFramework="net10.0"', 'targetFramework="net9.0"');
    expect(nuspecProblems("Workhorse.Hosting", text, "0.9.0", "0".repeat(40))).toEqual([
      "Workhorse.Hosting: the nuspec version is 0.9.1, not 0.9.0",
      "Workhorse.Hosting: the nuspec license is MIT, not Apache-2.0",
      `Workhorse.Hosting: the nuspec repository commit is ${commit}, not ${"0".repeat(40)}`,
      "Workhorse.Hosting: the nuspec has a dependency group for net9.0",
      "Workhorse.Hosting: the nuspec dependency on Workhorse is 0.8.0, not 0.9.0",
      "Workhorse.Hosting: the nuspec depends on Workhorse.Extra, which is not a package",
    ]);
    expect(nuspecProblems("Workhorse", "<package />", "0.9.0", commit)).toContain(
      "Workhorse: the nuspec readme is missing, not README.md",
    );
  });

  it("refuses a package without its README or documentation, or with another framework", () => {
    const entries = ["Workhorse.nuspec", "README.md", "lib/net10.0/Workhorse.dll"];
    expect(packageContentProblems("Workhorse", [...entries, "lib/net10.0/Workhorse.xml"])).toEqual(
      [],
    );
    expect(
      packageContentProblems("Workhorse", [...entries.slice(0, 1), ...entries.slice(2)]),
    ).toEqual([
      "Workhorse: the package lacks README.md",
      "Workhorse: the package lacks lib/net10.0/Workhorse.xml",
    ]);
    expect(
      packageContentProblems("Workhorse", [
        ...entries,
        "lib/net10.0/Workhorse.xml",
        "lib/net9.0/Workhorse.dll",
      ]),
    ).toEqual(["Workhorse: the package holds lib/net9.0/Workhorse.dll"]);
  });

  it("requires a deterministic PDB with a SourceLink map to the commit", () => {
    const sourceLink = `{"documents":{"/_/*":"https://raw.githubusercontent.com/stablemates/workhorse/${commit}/*"}}`;
    const pdb = Buffer.from(`BSJB\0/_/dotnet/src/Workhorse/Queue.cs\0${sourceLink}`, "latin1");
    expect(symbolProblems("Workhorse", pdb, commit, "/runner/work/workhorse")).toEqual([]);
    expect(symbolProblems("Workhorse", undefined, commit, "/checkout")).toEqual([
      "Workhorse: the symbol package lacks lib/net10.0/Workhorse.pdb",
    ]);
    const local = Buffer.from(`BSJB\0/checkout/dotnet/src/Workhorse/Queue.cs`, "latin1");
    expect(symbolProblems("Workhorse", local, commit, "/checkout")).toEqual([
      `Workhorse: the PDB has no SourceLink map to ${commit}`,
      "Workhorse: the PDB names the checkout /checkout, so the build is not deterministic",
    ]);
  });
});

describe("the release consumer", () => {
  it("takes the four packages only from the local feed", () => {
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

  it("passes the scratch database to Npgsql as a quoted connection string", () => {
    expect(connectionString("postgres://work%40horse:pa'ss@localhost:5433/workhorse_test_x")).toBe(
      "Host='localhost';Port='5433';Database='workhorse_test_x';Username='work@horse';Password='pa''ss'",
    );
    expect(connectionString("postgres://localhost/workhorse_test")).toBe(
      "Host='localhost';Port='5432';Database='workhorse_test'",
    );
  });

  it("names its scratch database in the shape pnpm db:sweep retires", () => {
    const source = "workhorse_test_sm_1629_dotnet_release_s_8d0dc6d4";
    const name = scratchDatabaseName(source, 4242);
    expect(name).toMatch(/_gc_[0-9a-f]{10}$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(
      classifyTestDatabase(name, {
        protectedNames: new Set([source]),
        familyRoots: testFamilyRoots([source]),
        liveTemplates: new Set(),
      }).kind,
    ).toBe("scratch");
  });
});
