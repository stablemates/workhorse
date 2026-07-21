import { readFile } from "node:fs/promises";
import type { Queryable } from "./types.js";

export async function installSchema(database: Queryable): Promise<void> {
  const schemaUrl = new URL("../sql/schema.sql", import.meta.url);
  const sql = await readFile(schemaUrl, "utf8");
  await database.query(sql);
}
