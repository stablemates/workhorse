import { DatabaseError } from "pg";
import { describe, expect, it } from "vitest";
import { describeDatabaseCause } from "../src/cli/database-cause.js";
import {
  describeInvalidSchemaIndexes,
  readInvalidSchemaIndexes,
  type InvalidSchemaIndex,
} from "../src/cli/schema-status.js";
import type { SchemaMigrationStep } from "../src/schema-migrations.js";
import type { Queryable } from "../src/types.js";

function driverError(
  message: string,
  fields: { code?: string; detail?: string; hint?: string } = {},
): DatabaseError {
  const error = new DatabaseError(message, message.length, "error");
  error.code = fields.code;
  error.detail = fields.detail;
  error.hint = fields.hint;
  return error;
}

const stepFailure = (cause: unknown) =>
  new Error("Workhorse migration 0002-broken.sql failed and was rolled back", { cause });

describe("describeDatabaseCause", () => {
  it("prints the message, SQLSTATE, DETAIL, and HINT of the driver error under a failed step", () => {
    const cause = driverError("relation does not exist", {
      code: "42P01",
      detail: "The step reads workhorse.task_runtime.",
      hint: "Install the schema.",
    });
    expect(describeDatabaseCause(stepFailure(cause))).toBe(
      "Cause: relation does not exist (SQLSTATE 42P01)\nDetail: The step reads workhorse.task_runtime.\nHint: Install the schema.\n",
    );
  });

  // A row of a Workhorse table can hold a task payload, and a payload can hold a credential.
  const secret = "postgres://user:secret@host/db";
  const withheld = "withheld, because it can quote the values of a row or an input";

  it.each(["23514", "23505"])(
    "withholds the DETAIL and HINT of SQLSTATE %s, which can quote the values of a row",
    (code) => {
      const cause = driverError('new row violates check constraint "probe"', {
        code,
        detail: `Failing row contains (${secret}).`,
        hint: `Check ${secret}.`,
      });
      const text = describeDatabaseCause(stepFailure(cause));
      expect(text).toBe(
        `Cause: new row violates check constraint "probe" (SQLSTATE ${code})\nDetail: ${withheld}\nHint: ${withheld}\n`,
      );
      expect(text).not.toContain("secret");
    },
  );

  it("withholds the message of a data exception, which can quote the input", () => {
    const cause = driverError(`invalid input syntax for type integer: "${secret}"`, {
      code: "22P02",
      detail: `Token "${secret}" is invalid.`,
    });
    const text = describeDatabaseCause(stepFailure(cause));
    expect(text).toBe(`Cause: ${withheld} (SQLSTATE 22P02)\nDetail: ${withheld}\n`);
    expect(text).not.toContain("secret");
  });

  it("leaves out a field that PostgreSQL did not give", () => {
    expect(describeDatabaseCause(stepFailure(driverError("division by zero")))).toBe(
      "Cause: division by zero\n",
    );
  });

  it("finds a driver error under another wrapper", () => {
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: driverError("x") }) });
    expect(describeDatabaseCause(wrapped)).toBe("Cause: x\n");
  });

  // A field of the same name on an error that the driver did not make can hold anything, for
  // example a connection string that a library put in a message.
  it("prints nothing for an error that the driver did not make", () => {
    const lookalike = Object.assign(new Error("postgres://user:secret@host/db"), {
      code: "XX000",
      detail: "secret",
    });
    expect(describeDatabaseCause(stepFailure(lookalike))).toBeUndefined();
  });

  // The top error already printed its own message as the first line.
  it("prints nothing for a driver error that is not a cause", () => {
    expect(describeDatabaseCause(driverError("top", { code: "42P01" }))).toBeUndefined();
  });

  it("stops on a cycle and after a bounded depth", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;
    expect(describeDatabaseCause(first)).toBeUndefined();

    let deep: unknown = driverError("too deep");
    for (let index = 0; index < 20; index += 1) deep = new Error(`wrap ${index}`, { cause: deep });
    expect(describeDatabaseCause(deep)).toBeUndefined();
  });

  it("removes terminal control characters and indents a continuation line", () => {
    const cause = driverError("bad \u001b[31mvalue\u0007\nsecond line", { code: "42601" });
    expect(describeDatabaseCause(stepFailure(cause))).toBe(
      "Cause: bad [31mvalue\n  second line (SQLSTATE 42601)\n",
    );
  });
});

const steps: readonly SchemaMigrationStep[] = [
  { fromVersion: 6, toVersion: 7, file: "0007.sql", description: "a", kind: "additive" },
  { fromVersion: 7, toVersion: 8, file: "0008.sql", description: "b", kind: "additive" },
  { fromVersion: 8, toVersion: 9, file: "0009.sql", description: "c", kind: "additive" },
];

const bodies: Readonly<Record<string, string>> = {
  "0007.sql": "CREATE INDEX shared_idx ON workhorse.task (id);",
  "0008.sql": `-- CREATE INDEX commented_idx ON workhorse.task (id);
CREATE INDEX ON workhorse.task (created_at);
DO $$ BEGIN EXECUTE 'CREATE INDEX inside_idx ON workhorse.task (id)'; END $$;
/* outer /* CREATE INDEX nested_idx ON workhorse.task (id); */ still a comment */
/* a comment */ CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Quoted_idx" ON workhorse.task (id);`,
  "0009.sql": "create index concurrently if not exists shared_idx on workhorse.task (id, state);",
};

function catalogue(names: readonly string[]): Queryable {
  return {
    query: async () => ({
      rows: names.map((name) => ({
        name: `workhorse.${name.includes("Q") ? `"${name}"` : name}`,
        index_name: name,
        table_name: "workhorse.task",
        valid: false,
        ready: true,
        partitioned: false,
      })),
      command: "SELECT",
      rowCount: names.length,
      oid: 0,
      fields: [],
    }),
  } as unknown as Queryable;
}

describe("readInvalidSchemaIndexes", () => {
  it("reads no migration file on a healthy database", async () => {
    const read: string[] = [];
    const result = await readInvalidSchemaIndexes(catalogue([]), {
      installedVersion: 9,
      migrations: steps,
      readStep: async (file) => {
        read.push(file);
        return bodies[file] ?? "";
      },
    });
    expect(result).toEqual([]);
    expect(read).toEqual([]);
  });

  it("names the newest step that builds each index, and no step for a name none builds", async () => {
    const result = await readInvalidSchemaIndexes(
      catalogue(["Quoted_idx", "commented_idx", "inside_idx", "nested_idx", "shared_idx"]),
      { installedVersion: 8, migrations: steps, readStep: async (file) => bodies[file] ?? "" },
    );
    expect(result.map((index) => [index.name, index.buildStep])).toEqual([
      ['workhorse."Quoted_idx"', { file: "0008.sql", fromVersion: 7, toVersion: 8, applied: true }],
      ["workhorse.commented_idx", null],
      ["workhorse.inside_idx", null],
      ["workhorse.nested_idx", null],
      ["workhorse.shared_idx", { file: "0009.sql", fromVersion: 8, toVersion: 9, applied: false }],
    ]);
    expect(result[0]?.dropStatement).toBe(
      'DROP INDEX CONCURRENTLY IF EXISTS workhorse."Quoted_idx";',
    );
  });
});

describe("describeInvalidSchemaIndexes", () => {
  it("prints nothing for no invalid index", () => {
    expect(describeInvalidSchemaIndexes([])).toBe("");
  });

  it("prints the drop statement and how the index is built again", () => {
    const base: Omit<InvalidSchemaIndex, "name" | "buildStep"> = {
      table: "workhorse.task",
      valid: false,
      ready: true,
      dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS workhorse.a_idx;",
    };
    const text = describeInvalidSchemaIndexes([
      {
        ...base,
        name: "workhorse.a_idx",
        buildStep: { file: "0009.sql", fromVersion: 8, toVersion: 9, applied: false },
      },
      { ...base, name: "workhorse.b_idx", buildStep: null },
    ]);
    expect(text).toContain(
      "Index workhorse.a_idx on workhorse.task is not valid. Drop it with: DROP INDEX CONCURRENTLY IF EXISTS workhorse.a_idx;",
    );
    expect(text).toContain('Then run "workhorse schema migrate". Migration 0009.sql builds');
    expect(text).toContain("No migration step builds an index of this name.");
    expect(text).toContain("A CREATE INDEX CONCURRENTLY that still runs");
  });
});
