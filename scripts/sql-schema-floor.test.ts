import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  introducedVersions,
  readCallerSources,
  readSignatureSources,
  referencedObjects,
  requiredFloor,
  type SignatureSource,
} from "./sql-schema-floor.js";

const repository = path.resolve(import.meta.dirname, "..");

/** The generated statement catalogues, one per SDK, and the dashboard read model beside each. */
const callerRoots = [
  "typescript/core/src/queue/sql-catalogue.generated.ts",
  "go/sql_catalogue_generated.go",
  "python/src/workhorse/_statements.py",
];
const dashboardRoots = [
  "typescript/dashboard-server/src",
  "go/dashboard",
  "python/src/workhorse/dashboard",
];

const manifest = JSON.parse(
  await readFile(path.join(repository, "protocol/v1/manifest.json"), "utf8"),
) as { schema: { minimumVersion: number; installedVersion: number } };

const sources = await readSignatureSources(repository);
const introduced = introducedVersions(sources);

async function floorFor(files: readonly string[]): Promise<ReturnType<typeof requiredFloor>> {
  const references = new Set<string>();
  for (const file of files) for (const name of referencedObjects(file)) references.add(name);
  return requiredFloor(introduced, references);
}

describe("schema floor", () => {
  it("reads the ordered sql tree for the version that introduced each object", () => {
    // Spot-checks in three places: the baseline, a mid-chain migration, and the newest step. A
    // wrong answer here would silently lower every floor derived below.
    expect(introduced.get("claim_v1")).toBe(1);
    expect(introduced.get("dashboard_checkpoint_value_v1")).toBe(6);
    expect(introduced.get("dashboard_task_value_v1")).toBe(17);
  });

  it("keeps the floor at or above the version that introduced every statement it calls", async () => {
    const catalogues = await Promise.all(
      callerRoots.map((file) => readFile(path.join(repository, file), "utf8")),
    );
    const floor = await floorFor(catalogues);

    expect({ required: floor.version, introducedBy: floor.introducedBy }).toEqual({
      required: 18,
      introducedBy: ["release_owned_v1"],
    });
    expect(manifest.schema.minimumVersion).toBeGreaterThanOrEqual(floor.version);
  });

  it("keeps the floor at or above the version that introduced every dashboard read it calls", async () => {
    // The dashboard host each SDK ships reaches the schema directly, and it goes through the same
    // compatibility gate, so its newest read sets the release's floor.
    const dashboards = (
      await Promise.all(
        dashboardRoots.map((root) => readCallerSources(path.join(repository, root))),
      )
    ).flat();
    const floor = await floorFor(dashboards);

    expect({ required: floor.version, introducedBy: floor.introducedBy }).toEqual({
      required: 17,
      introducedBy: ["dashboard_task_value_v1"],
    });
    expect(manifest.schema.minimumVersion).toBeGreaterThanOrEqual(floor.version);
  });

  it("never raises the floor past the version the release installs", () => {
    // A floor above the installed version would refuse the schema this release's own clean
    // installation writes, which is a release that cannot run against itself.
    expect(manifest.schema.minimumVersion).toBeLessThanOrEqual(manifest.schema.installedVersion);
  });

  it("ignores a name the sql tree does not define", () => {
    // Catalogues interpolate names that are not schema objects, and the governed-surface check is
    // what holds the callable surface honest. An unknown name must not move a floor.
    const baseline: SignatureSource = {
      kind: "release",
      version: 1,
      file: "sql/releases/0001.sql",
      source: "CREATE TABLE IF NOT EXISTS workhorse.task (id uuid PRIMARY KEY);",
    };
    const versions = introducedVersions([baseline]);

    expect(requiredFloor(versions, ["task", "not_a_schema_object"])).toEqual({
      version: 1,
      introducedBy: ["task"],
    });
  });
});
