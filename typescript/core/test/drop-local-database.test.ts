import { describe, expect, it } from "vitest";
import { dropLocalDatabase, type DatabaseDropAdmin } from "../src/drop-local-database.js";

function objectInUse(): Error {
  return Object.assign(new Error('database "scratch_test" is being accessed by other users'), {
    code: "55006",
  });
}

/**
 * A stand-in for a PostgreSQL admin connection whose target database holds a session the caller's
 * role may not terminate, such as an autovacuum worker. `pg_terminate_backend` over the caller's
 * own sessions leaves it attached; only its own exit, after `busyDrops` refusals, frees the drop.
 */
function adminWithForeignSession(busyDrops: number): {
  admin: DatabaseDropAdmin;
  statements: string[];
} {
  const statements: string[] = [];
  let refusals = 0;
  const admin: DatabaseDropAdmin = {
    async query(text) {
      statements.push(text);
      if (/WITH\s*\(\s*FORCE\s*\)/i.test(text)) {
        throw Object.assign(new Error("permission denied to terminate process"), {
          code: "42501",
        });
      }
      if (text.startsWith("DROP DATABASE")) {
        if (refusals < busyDrops) {
          refusals++;
          throw objectInUse();
        }
        return { rows: [] };
      }
      if (text.includes("backend_type")) {
        return {
          rows: [
            { pid: 4242, usename: null, backend_type: "autovacuum worker", application_name: "" },
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { admin, statements };
}

describe("dropLocalDatabase", () => {
  it("waits out a session its role cannot terminate instead of forcing the drop", async () => {
    const { admin, statements } = adminWithForeignSession(3);

    await dropLocalDatabase(admin, "scratch_test", { retryMs: 1 });

    const drops = statements.filter((statement) => statement.startsWith("DROP DATABASE"));
    expect(drops).toEqual(Array(4).fill('DROP DATABASE IF EXISTS "scratch_test"'));
    const terminations = statements.filter((statement) =>
      statement.includes("pg_terminate_backend"),
    );
    expect(terminations).toHaveLength(3);
    for (const termination of terminations) expect(termination).toMatch(/usename = current_user/);
  });

  it("names the sessions that outlast every attempt", async () => {
    const { admin, statements } = adminWithForeignSession(Number.POSITIVE_INFINITY);

    const failure = dropLocalDatabase(admin, "scratch_test", { attempts: 3, retryMs: 1 });

    await expect(failure).rejects.toThrow(
      "Could not drop scratch_test: other sessions kept it in use through 3 attempts: " +
        "pid 4242 (autovacuum worker, role none)",
    );
    expect(statements.filter((statement) => statement.startsWith("DROP DATABASE"))).toHaveLength(3);
  });

  it("rethrows a failure that is not a busy database without retrying", async () => {
    const statements: string[] = [];
    const denied = Object.assign(new Error("must be owner of database scratch_test"), {
      code: "42501",
    });
    const admin: DatabaseDropAdmin = {
      async query(text) {
        statements.push(text);
        throw denied;
      },
    };

    await expect(dropLocalDatabase(admin, "scratch_test", { retryMs: 1 })).rejects.toBe(denied);
    expect(statements).toHaveLength(1);
  });

  it("quotes the database name as an identifier", async () => {
    const { admin, statements } = adminWithForeignSession(0);

    await dropLocalDatabase(admin, 'odd"name_test');

    expect(statements).toEqual(['DROP DATABASE IF EXISTS "odd""name_test"']);
  });
});
