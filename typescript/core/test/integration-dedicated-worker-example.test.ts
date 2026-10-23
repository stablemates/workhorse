import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);
const { pool } = database;
// A non-literal specifier keeps the type checker away from the untyped .mjs example. Vitest still
// resolves its `@stablemates/workhorse` import to the source.
const exampleUrl = new URL("../../examples/dedicated-worker.mjs", import.meta.url).href;
const { verifyDedicatedWorker } = (await import(exampleUrl)) as {
  verifyDedicatedWorker(databaseUrl: string): Promise<{ taskId: string; result: unknown }>;
};

const COMPLETION_GATE_KEY = 1748;
// Only a completion writes a task outcome, so this gate holds no enqueue, claim, or checkpoint.
const HOLD_TASK_OUTCOME_INSERTS = `
CREATE FUNCTION public.hold_task_outcome_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(${COMPLETION_GATE_KEY});
  RETURN NEW;
END
$$;
CREATE TRIGGER hold_task_outcome_insert BEFORE INSERT ON workhorse.task_outcome
  FOR EACH ROW EXECUTE FUNCTION public.hold_task_outcome_insert();
CREATE TRIGGER hold_task_outcome_insert BEFORE INSERT ON workhorse.fast_task_outcome
  FOR EACH ROW EXECUTE FUNCTION public.hold_task_outcome_insert();
`;

beforeAll(database.setup);
afterAll(database.teardown);

async function completionWaitsAtGate(gate: PoolClient): Promise<boolean> {
  const { rows } = await gate.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND objid = $1 AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [COMPLETION_GATE_KEY],
  );
  return rows[0]!.waiting > 0;
}

it("waits for a completion that a busy database holds past two seconds", async () => {
  // The example once gave up after 100 polls of 20 ms. A gate holds the completion write, as a
  // busy PostgreSQL does, for longer than that.
  const gate = await pool.connect();
  try {
    await gate.query(HOLD_TASK_OUTCOME_INSERTS);
    await gate.query("SELECT pg_advisory_lock($1)", [COMPLETION_GATE_KEY]);
    const verification = verifyDedicatedWorker(database.databaseUrl).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await expect
        .poll(() => completionWaitsAtGate(gate), { timeout: 20_000, interval: 20 })
        .toBe(true);
      await delay(3_000);
    } finally {
      // Wait for the example to stop its worker and pools before teardown drops the database.
      await gate.query("SELECT pg_advisory_unlock($1)", [COMPLETION_GATE_KEY]);
      await verification;
    }
    const outcome = await verification;
    expect(outcome).toMatchObject({
      value: { result: { payload: { orderId: "order-42" }, prepared: true } },
    });
  } finally {
    gate.release();
  }
}, 60_000);
