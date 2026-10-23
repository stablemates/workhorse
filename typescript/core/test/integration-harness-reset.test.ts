import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";
import {
  changeEveryMaintenanceColumn,
  installMaintenanceState,
  readMaintenanceState,
} from "./support/maintenance-state.js";

// Test files that use createDatabaseTestHarness directly call its reset without the beforeEach of
// createIntegrationTestContext, so the reset itself must return maintenance_state to install.
const database = createDatabaseTestHarness(import.meta.url);

beforeAll(database.setup);
afterAll(database.teardown);

it("returns every maintenance_state column to its install value", async () => {
  await changeEveryMaintenanceColumn(database.pool);
  for (const row of await readMaintenanceState(database.pool)) {
    expect(installMaintenanceState).not.toContainEqual(row);
  }
  await database.reset();
  expect(await readMaintenanceState(database.pool)).toEqual(installMaintenanceState);
});
