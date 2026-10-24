import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";
import { runCliScript } from "./support/cli-process.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repository, "typescript/core/src/cli/reset-db.ts");
const harness = createDatabaseTestHarness(import.meta.url, { schemaProvisioning: "install" });

function resetDb(args: readonly string[], environment: NodeJS.ProcessEnv) {
  return runCliScript(cli, args, {
    cwd: repository,
    env: { ...process.env, WORKHORSE_ALLOW_REMOTE_RESET: undefined, ...environment },
    // The reset drops a database, so it can wait for a checkpoint as long as a database hook.
    timeoutMs: inject("databaseHookTimeout"),
  });
}

// The reset drops a database in the test body. A drop waits for a checkpoint, and under load that
// wait can pass the default test timeout. The test gets the timeout of the database hooks, which
// wait for the same checkpoints.
const dropWait = { timeout: inject("databaseHookTimeout") };

// The reset terminates the harness pool's idle sessions along with the holder below.
harness.pool.on("error", () => {});
beforeAll(harness.setup);
afterAll(harness.teardown);

describe("db:reset", () => {
  it("refuses without confirmation", async () => {
    const result = await resetDb(["--database", "test"], {
      DATABASE_URL_TEST: harness.databaseUrl,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Pass --yes to confirm the destructive reset");
  });

  it("refuses a database whose name lacks the purpose suffix", async () => {
    const wrongPurpose = new URL(harness.databaseUrl);
    wrongPurpose.pathname = "/workhorse_bench";
    const result = await resetDb(["--database", "test", "--yes"], {
      DATABASE_URL_TEST: wrongPurpose.toString(),
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Refusing to use database "workhorse_bench" for test');
  });

  it("refuses a remote host", async () => {
    const result = await resetDb(["--database", "test", "--yes"], {
      DATABASE_URL_TEST: "postgres://workhorse:workhorse@db.invalid:5432/workhorse_test",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "Refusing to reset a remote database without WORKHORSE_ALLOW_REMOTE_RESET=1",
    );
  });

  it("resets a database while a session of its own role holds it open", dropWait, async () => {
    const holder = new Client({ connectionString: harness.databaseUrl });
    // The test process reads the termination while the reset runs, so the client reports it here.
    const holderErrors: Error[] = [];
    holder.on("error", (error) => holderErrors.push(error));
    await holder.connect();
    try {
      await holder.query("CREATE TABLE public.reset_marker (id int)");

      const result = await resetDb(["--database", "test", "--yes"], {
        DATABASE_URL_TEST: harness.databaseUrl,
      });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      await expect(holder.query("SELECT 1")).rejects.toThrow(/terminat|connection error/i);
      expect(holderErrors.map((error) => error.message).join("\n")).toMatch(/terminat/i);
    } finally {
      await holder.end().catch(() => {});
    }

    const observer = new Client({ connectionString: harness.databaseUrl });
    await observer.connect();
    try {
      const tables = await observer.query<{ marker: boolean; schema: boolean }>(
        `SELECT to_regclass('public.reset_marker') IS NOT NULL AS marker,
                to_regclass('workhorse.schema_version') IS NOT NULL AS schema`,
      );
      expect(tables.rows[0]).toEqual({ marker: false, schema: true });
    } finally {
      await observer.end();
    }
  });
});
