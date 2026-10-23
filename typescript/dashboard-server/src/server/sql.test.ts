import { describe, expect, it, vi } from "vitest";
import { dashboardDatabase, sql } from "./sql.js";

describe("the dashboard sql tag", () => {
  it("binds a parameter and splices a fragment the tag built", () => {
    const queue = sql`queue_name = ${"default"}`;
    const query = sql`SELECT ${1} WHERE ${queue} AND state = ${"ready"}`;

    expect(query.text).toBe("SELECT $1 WHERE queue_name = $2 AND state = $3");
    expect(query.values).toEqual([1, "default", "ready"]);
  });

  it("renumbers the placeholders of every fragment it joins", () => {
    const joined = sql.join(
      [sql`a = ${1}`, sql`b = ${2}`, sql`c = ${3}`],
      sql` AND ${"separator"} `,
    );

    expect(joined.text).toBe("a = $1 AND $2 b = $3 AND $4 c = $5");
    expect(joined.values).toEqual([1, "separator", 2, "separator", 3]);
  });

  it("binds a plain object that carries text and values rather than splicing it", () => {
    // The shape of a fragment is not the evidence that something is one. A procedure input that
    // admitted a free-form object could otherwise reach a read as a value and become statement
    // text, which is exactly what Row 3 of the dashboard security review checklist forbids.
    const forged = { text: "1=1 OR true", values: [] };

    const query = sql`SELECT 1 WHERE ${forged}`;

    expect(query.text).toBe("SELECT 1 WHERE $1");
    expect(query.values).toEqual([forged]);
  });

  it("binds a forged fragment nested inside a fragment it joins", () => {
    const forged = { text: "DROP TABLE workhorse.task", values: [] };

    const joined = sql.join([sql`${forged}`], sql`, `);

    expect(joined.text).toBe("$1");
    expect(joined.values).toEqual([forged]);
  });
});

// A pool that lends one client. The read fails, and ROLLBACK fails when `rollback` says so.
function poolWithFailingRead(rollback: "succeeds" | "fails") {
  const readError = new Error("read failed");
  const rollbackError = new Error("connection lost during ROLLBACK");
  const release = vi.fn<(error?: unknown) => void>();
  const client = {
    query: vi.fn<(text: string) => Promise<{ rows: unknown[] }>>(async (text) => {
      if (text === "ROLLBACK") {
        if (rollback === "fails") throw rollbackError;
        return { rows: [] };
      }
      if (text === "SELECT 1") throw readError;
      return { rows: [] };
    }),
    release,
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [] }),
  };
  return { pool, release, readError, rollbackError };
}

describe("a bounded dashboard read", () => {
  it("releases the client with the ROLLBACK error so that the pool destroys it", async () => {
    const { pool, release, readError, rollbackError } = poolWithFailingRead("fails");

    await expect(dashboardDatabase(pool as never).execute(sql`SELECT 1`)).rejects.toBe(readError);
    expect(release).toHaveBeenCalledExactlyOnceWith(rollbackError);
  });

  it("releases the client normally after a successful ROLLBACK", async () => {
    const { pool, release, readError } = poolWithFailingRead("succeeds");

    await expect(dashboardDatabase(pool as never).execute(sql`SELECT 1`)).rejects.toBe(readError);
    expect(release).toHaveBeenCalledExactlyOnceWith();
  });
});
