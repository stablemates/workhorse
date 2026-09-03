import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { composeDashboardBindings } from "../spec/generate-bindings.js";
import { composeDashboardSpec } from "../spec/generate.js";
import { dashboardDefinitionPrefix } from "../spec/response-schemas.js";

const repositoryDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const artifactDirectory = join(repositoryDirectory, "dashboard", "v1");

// Building the checker program over the router's type graph dominates this test's runtime.
it("commits dashboard/v1 artifacts that match the router", { timeout: 120_000 }, async () => {
  const artifacts = composeDashboardSpec();
  for (const [name, content] of Object.entries(artifacts)) {
    const committed = await readFile(join(artifactDirectory, name), "utf8");
    expect(committed, `${name} is stale; run pnpm dashboard-spec:generate`).toBe(content);
  }
  const bindings = await composeDashboardBindings();
  for (const [name, content] of Object.entries(bindings)) {
    const committed = await readFile(join(repositoryDirectory, name), "utf8");
    expect(committed, `${name} is stale; run pnpm dashboard-spec:generate`).toBe(content);
  }
});

it("names every shared wire type with the Dashboard prefix", async () => {
  const committed = await readFile(join(artifactDirectory, "procedures.json"), "utf8");
  const contract = JSON.parse(committed) as { $defs: Record<string, unknown> };
  const names = Object.keys(contract.$defs);
  expect(names.length).toBeGreaterThan(0);
  // A core type that reaches a response would otherwise name a second CancelStatus or Json in the
  // generated Go and Python bindings, beside the core one the same SDK already exports.
  expect(names.filter((name) => !name.startsWith(dashboardDefinitionPrefix))).toEqual([]);
});
