import {
  assertSchemaCompatible,
  installSchema,
  migrateSchema,
  readProtocolVersions,
  readSchemaVersion,
  WORKHORSE_SCHEMA_VERSION,
} from "@stablemates/workhorse";
import { Pool } from "pg";
import { assertDemoSchemaCompatible, installDemoSchema } from "./app.js";
import { createDemoDatabase } from "./database.js";
import { resolveDemoSchemaTargets } from "./environment.js";
import { prepareSchema } from "./schema-preparation.js";

/**
 * The demo's schema step, run once from the deployment pipeline before any container starts.
 *
 * This is where the demo obeys the rule it documents. A migration is a pipeline step and no
 * component migrates on start
 * ([ADR 0053](../../../docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)),
 * so this program runs from `.kamal/hooks/pre-deploy` in the image being deployed, and the
 * container entry point only starts processes.
 *
 * It also stands in for the `workhorse schema status --json` verification the installation page
 * documents, because the demo has two databases and a second schema of its own. Preparing and then
 * verifying both in one program means the deploy fails here, before a container boots, rather than
 * on a health check that cannot say why.
 */
for (const target of resolveDemoSchemaTargets()) {
  const pool = new Pool({ connectionString: target.url, max: 1 });
  try {
    const result = await prepareSchema({
      readVersion: () => readSchemaVersion(pool),
      install: () => installSchema(pool),
      migrate: () => migrateSchema(pool),
      installDemo: () => installDemoSchema(createDemoDatabase(pool)),
    });
    // Verify what was just written with the same checks the application makes at startup. A
    // failure here rejects the deployment; the same failure after the swap is an outage.
    await assertSchemaCompatible(pool);
    await assertDemoSchemaCompatible(createDemoDatabase(pool));
    const installed = await readSchemaVersion(pool);
    const served = await readProtocolVersions(pool);
    process.stdout.write(
      `Workhorse ${target.name} demo schema ${result} successfully. ${JSON.stringify({
        installedVersion: installed,
        expectedVersion: WORKHORSE_SCHEMA_VERSION,
        servedProtocolVersions: served,
        compatible: true,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}
