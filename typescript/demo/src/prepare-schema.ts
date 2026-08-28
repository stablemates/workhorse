import { installSchema, migrateSchema, readSchemaVersion } from "@stablemates/workhorse";
import { Pool } from "pg";
import { installDemoSchema } from "./app.js";
import { createDemoDatabase } from "./database.js";
import { resolveDemoSchemaTargets } from "./environment.js";
import { prepareSchema } from "./schema-preparation.js";

for (const target of resolveDemoSchemaTargets()) {
  const pool = new Pool({ connectionString: target.url, max: 1 });
  try {
    const result = await prepareSchema({
      readVersion: () => readSchemaVersion(pool),
      install: () => installSchema(pool),
      migrate: () => migrateSchema(pool),
      installDemo: () => installDemoSchema(createDemoDatabase(pool)),
    });
    process.stdout.write(`Workhorse ${target.name} demo schema ${result} successfully.\n`);
  } finally {
    await pool.end();
  }
}
