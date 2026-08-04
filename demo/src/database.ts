import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { orders } from "./schema.js";

/** The application's own Drizzle database. Workhorse enqueues inside its transactions. */
export function createDemoDatabase(pool: Pool) {
  return drizzle({ client: pool, schema: { orders } });
}

export type DemoDatabase = ReturnType<typeof createDemoDatabase>;
