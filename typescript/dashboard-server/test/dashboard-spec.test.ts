import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { composeDashboardSpec } from "../spec/generate.js";

const artifactDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dashboard",
  "v1",
);

// Building the checker program over the router's type graph dominates this test's runtime.
it("commits dashboard/v1 artifacts that match the router", { timeout: 120_000 }, async () => {
  const artifacts = composeDashboardSpec();
  for (const [name, content] of Object.entries(artifacts)) {
    const committed = await readFile(join(artifactDirectory, name), "utf8");
    expect(committed, `${name} is stale; run pnpm dashboard-spec:generate`).toBe(content);
  }
});
