import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  loadDashboardConformanceFixtures,
  verifyDashboardConformanceFixtures,
} from "../../../scripts/verify-dashboard-conformance.js";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";
import { createDashboardConformanceTransport } from "./support/conformance-harness.js";

const database = createDatabaseTestHarness(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The reference implementation is bound by the committed HTTP fixtures: every exchange in
// `dashboard/v1/conformance.json` must answer with its golden status and body, and the file must
// cover the whole procedure surface. Regenerate with `pnpm dashboard-conformance:generate`.
it(
  "passes the dashboard/v1 HTTP conformance fixtures as the reference implementation",
  { timeout: 120_000 },
  async () => {
    await database.setup();
    try {
      const { fixtures } = await loadDashboardConformanceFixtures(repository);
      const transport = createDashboardConformanceTransport(database.pool, fixtures.harness);
      const report = await verifyDashboardConformanceFixtures(database.pool, repository, transport);
      expect(report.scenarios).toBeGreaterThan(0);
      expect(report.seedSteps).toBeGreaterThan(0);
      expect(report.exchanges).toBeGreaterThan(report.scenarios);
    } finally {
      await database.teardown();
    }
  },
);
