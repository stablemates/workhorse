import { readFile } from "node:fs/promises";
import type { Queryable } from "./types.js";

export async function installSchema(database: Queryable): Promise<void> {
  // Validation uses a canonical clean-database schema rather than incremental migrations.
  // Production callers must not treat this as a safe upgrade mechanism for an existing schema.
  const schemaUrl = new URL("../sql/schema.sql", import.meta.url);
  const sql = await readFile(schemaUrl, "utf8");
  await database.query(sql);
}
