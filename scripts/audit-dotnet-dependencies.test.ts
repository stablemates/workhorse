import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  advisoryProblems,
  floorProblems,
  parsePackageReport,
  shippedFloors,
} from "./audit-dotnet-dependencies.js";

const source = "https://api.nuget.org/v3/index.json";

// Trimmed from `dotnet list package --vulnerable --include-transitive --format json` on .NET 10.
function report(packages: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    parameters: "--vulnerable --include-transitive",
    sources: [source],
    projects: [
      { path: "/repo/dotnet/floor-consumer/FloorConsumer.csproj" },
      {
        path: "/repo/dotnet/floor-consumer/FloorConsumer.csproj",
        frameworks: [{ framework: "net10.0", transitivePackages: packages }],
      },
    ],
    ...extra,
  });
}

const vulnerablePackage = {
  id: "Newtonsoft.Json",
  resolvedVersion: "12.0.1",
  vulnerabilities: [
    { severity: "High", advisoryurl: "https://github.com/advisories/GHSA-5crp-9r3c-p9vr" },
  ],
};

describe("the .NET dependency scan", () => {
  it("reads the floors of the shipped dependencies only", async () => {
    const floors = shippedFloors(
      await readFile(new URL("../dotnet/Directory.Packages.props", import.meta.url), "utf8"),
    );

    expect(floors.get("Npgsql")).toBe("10.0.3");
    expect(floors.get("Microsoft.EntityFrameworkCore.Relational")).toBe("10.0.0");
    // A test dependency never reaches a caller.
    expect(floors.has("xunit.v3")).toBe(false);
    expect(floors.has("Npgsql.EntityFrameworkCore.PostgreSQL")).toBe(false);
  });

  it("refuses a props file without the shipped item group", () => {
    expect(() => shippedFloors("<Project />")).toThrow("no Shipped dependencies item group");
  });

  it("fails on each advisory, whatever its severity", () => {
    const low = { ...vulnerablePackage, vulnerabilities: [{ severity: "Low", advisoryurl: "u" }] };

    expect(advisoryProblems(parsePackageReport(report([vulnerablePackage, low])))).toEqual([
      "Newtonsoft.Json 12.0.1 has a High advisory: https://github.com/advisories/GHSA-5crp-9r3c-p9vr",
      "Newtonsoft.Json 12.0.1 has a Low advisory: u",
    ]);
  });

  it("passes a listing from nuget.org with no advisory", () => {
    expect(advisoryProblems(parsePackageReport(report([])))).toEqual([]);
  });

  it("refuses a listing that read no advisory source or reported a problem", () => {
    expect(advisoryProblems(parsePackageReport(report([], { sources: [] })))).toEqual([
      `the listing did not read the advisories of ${source}`,
    ]);
    expect(
      advisoryProblems(
        parsePackageReport(report([], { problems: [{ level: "error", text: "no assets file" }] })),
      ),
    ).toEqual(["error: no assets file"]);
  });

  it("refuses a report of another format version", () => {
    expect(() => parsePackageReport(report([], { version: 2 }))).toThrow("report version 2");
  });

  it("refuses a shipped dependency above its floor or absent from the graph", () => {
    const floors = new Map([
      ["Npgsql", "10.0.3"],
      ["Microsoft.EntityFrameworkCore.Relational", "10.0.0"],
      ["Microsoft.Extensions.Logging.Abstractions", "10.0.0"],
    ]);
    const resolved = parsePackageReport(
      report([
        { id: "Npgsql", resolvedVersion: "10.0.3" },
        { id: "Microsoft.EntityFrameworkCore.Relational", resolvedVersion: "10.0.4" },
      ]),
    );

    expect(floorProblems(floors, resolved)).toEqual([
      "dotnet/floor-consumer/FloorConsumer.csproj resolves Microsoft.EntityFrameworkCore.Relational 10.0.4, not its floor 10.0.0",
      "dotnet/floor-consumer/FloorConsumer.csproj does not resolve Microsoft.Extensions.Logging.Abstractions",
    ]);
  });
});
