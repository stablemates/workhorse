import { expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";
import {
  changeEveryMaintenanceColumn,
  installMaintenanceState,
  knownMaintenanceColumns,
  readMaintenanceColumns,
  readMaintenanceState,
} from "./support/maintenance-state.js";

const { pool } = createIntegrationTestContext(import.meta.url);

// Vitest runs the tests of a file in order. The first test changes the maintenance state, and the
// second test checks that the beforeEach of createIntegrationTestContext returned it to install.
it("leaves maintenance state that differs from the install state", async () => {
  await changeEveryMaintenanceColumn(pool);
  for (const row of await readMaintenanceState(pool)) {
    expect(installMaintenanceState).not.toContainEqual(row);
  }
});

it("starts the next test with the install state of every maintenance routine", async () => {
  expect(await readMaintenanceState(pool)).toEqual(installMaintenanceState);
});

it("covers every maintenance_state column", async () => {
  // If this fails, reset the new column in maintenanceStateReset in db.ts and check it in
  // support/maintenance-state.ts.
  expect(await readMaintenanceColumns(pool)).toEqual(knownMaintenanceColumns);
});
