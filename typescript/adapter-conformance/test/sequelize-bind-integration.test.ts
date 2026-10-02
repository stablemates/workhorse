import { createRequire } from "node:module";
import { QueryTypes, Sequelize, type Transaction } from "sequelize";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";

const database = createDatabaseTestHarness(import.meta.url);
const require = createRequire(import.meta.url);
const sequelizePackage = require("sequelize/package.json") as { version: string };
const sequelize = new Sequelize(database.databaseUrl, {
  logging: false,
  retry: { max: 0 },
});

const rejectedCases = [
  {
    name: "a quoted string",
    statement: "SELECT $1::text AS value, '$2' AS literal",
    expected: [{ value: "bound", literal: "$2" }],
    missing: "$2",
  },
  {
    name: "an escaped string",
    statement: "SELECT $1::text AS value, E'\\\'$2' AS escaped",
    expected: [{ value: "bound", escaped: "'$2" }],
    missing: "$2",
  },
  {
    name: "a quoted identifier",
    statement: 'SELECT $1::text AS "$2"',
    expected: [{ $2: "bound" }],
    missing: "$2",
  },
  {
    name: "a line comment",
    statement: "SELECT $1::text AS value -- $2\n",
    expected: [{ value: "bound" }],
    missing: "$2",
  },
  {
    name: "a nested block comment",
    statement: "SELECT $1::text AS value /* $2 /* $2 */ $2 */",
    expected: [{ value: "bound" }],
    missing: "$2",
  },
  {
    name: "a tagged dollar quote",
    statement: "SELECT $1::text AS value, $tag$ $2 $$ $tag$ AS body",
    expected: [{ value: "bound", body: " $2 $$ " }],
    missing: "$tag",
  },
  {
    name: "an untagged dollar quote",
    statement: "SELECT $1::text AS value, $$ $2 $$ AS body",
    expected: [{ value: "bound", body: " $2 " }],
    missing: "$2",
  },
  {
    name: "the complete shared conformance lexical fixture",
    statement: [
      "SELECT $1::text AS value, '$2' AS literal, E'\\\'$2' AS escaped, 1 AS \"$2\",",
      "  $tag$ $2 $$ $tag$ AS body -- $2",
      "/* $2 /* $2 */ $2 */",
    ].join("\n"),
    expected: [{ value: "bound", literal: "$2", escaped: "'$2", $2: 1, body: " $2 $$ " }],
    missing: "$2",
  },
];

async function rawQuery(statement: string, values: readonly unknown[], transaction: Transaction) {
  const [rows] = await sequelize.query(statement, {
    bind: [...values],
    transaction,
    type: QueryTypes.RAW,
    raw: true,
  });
  return rows;
}

beforeAll(async () => {
  await database.setup();
});

afterAll(async () => {
  await sequelize.close();
  await database.teardown();
});

describe("Sequelize 6.37.8 unsupported native-bind gate", () => {
  it("executes the pinned stable release, not an alpha or untested upgrade", () => {
    expect(sequelizePackage.version).toBe("6.37.8");
  });

  it.each(rejectedCases)("rejects PostgreSQL-valid SQL containing $name", async (fixture) => {
    const values = ["bound"];
    const native = await database.pool.query(fixture.statement, values);
    expect(native.rows).toEqual(fixture.expected);

    await sequelize.transaction(async (transaction) => {
      await expect(rawQuery(fixture.statement, values, transaction)).rejects.toThrow(
        `Named bind parameter "${fixture.missing}" has no value in the given object.`,
      );
      expect(await rawQuery("SELECT $1::text AS value", values, transaction)).toEqual([
        { value: "bound" },
      ]);
    });
    expect(values).toEqual(["bound"]);
  });

  it("silently changes a double dollar inside a quoted string", async () => {
    const statement = "SELECT $1::text AS value, '$$' AS literal";
    const values = ["bound"];
    const native = await database.pool.query(statement, values);
    expect(native.rows).toEqual([{ value: "bound", literal: "$$" }]);

    await sequelize.transaction(async (transaction) => {
      const logged: string[] = [];
      const [rows] = await sequelize.query(statement, {
        bind: [...values],
        transaction,
        type: QueryTypes.RAW,
        raw: true,
        logging: (sql) => logged.push(sql),
      });
      expect(rows).toEqual([{ value: "bound", literal: "$" }]);
      expect(rows).not.toEqual(native.rows);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(": SELECT $1::text AS value, '$' AS literal");
    });
  });

  it("preserves repeated, out-of-order native parameters without interpolation", async () => {
    const statement = "SELECT $2::text AS second, $1::text AS first, $2::text AS repeated";
    const values = ["'$2; -- not SQL", "second"];
    const native = await database.pool.query(statement, values);
    expect(native.rows).toEqual([
      { second: "second", first: "'$2; -- not SQL", repeated: "second" },
    ]);
    await sequelize.transaction(async (transaction) => {
      expect(await rawQuery(statement, values, transaction)).toEqual(native.rows);
    });
  });

  it("preserves PostgreSQL JSON question-mark operators", async () => {
    const statement = [
      "SELECT $1::jsonb ? 'key' AS has_key,",
      "$1::jsonb ?| ARRAY['key','absent'] AS any_key,",
      "$1::jsonb ?& ARRAY['key'] AS all_keys",
    ].join(" ");
    const values = [{ key: true }];
    const native = await database.pool.query(statement, values);
    expect(native.rows).toEqual([{ has_key: true, any_key: true, all_keys: true }]);
    await sequelize.transaction(async (transaction) => {
      expect(await rawQuery(statement, values, transaction)).toEqual(native.rows);
    });
  });

  it("returns raw timestamp, JSON and array rows for the passing control", async () => {
    const statement =
      "SELECT $1::timestamptz AS happened_at, $2::jsonb AS payload, $3::int[] AS numbers";
    const values = [new Date("2026-10-02T00:00:00Z"), { nested: [1, true, null] }, [1, 2]];
    const native = await database.pool.query(statement, values);
    expect(native.rows).toEqual([
      { happened_at: values[0], payload: values[1], numbers: values[2] },
    ]);
    expect(native.rows[0].happened_at).toBeInstanceOf(Date);
    await sequelize.transaction(async (transaction) => {
      expect(await rawQuery(statement, values, transaction)).toEqual(native.rows);
    });
  });

  it("rejects finished transactions rather than falling back to the pool", async () => {
    const transaction = await sequelize.transaction();
    await transaction.rollback();
    await expect(rawQuery("SELECT $1::text AS value", ["bound"], transaction)).rejects.toThrow(
      "rollback has been called on this transaction",
    );
  });

  it("retains an aborted transaction and its PostgreSQL SQLSTATE", async () => {
    const transaction = await sequelize.transaction();
    try {
      await expect(rawQuery("SELECT 1 / $1::int", [0], transaction)).rejects.toMatchObject({
        original: { code: "22012" },
      });
      await expect(
        rawQuery("SELECT $1::text AS value", ["bound"], transaction),
      ).rejects.toMatchObject({
        original: { code: "25P02" },
      });
    } finally {
      await transaction.rollback();
    }
  });

  it("does not itself reject a transaction owned by another Sequelize instance", async () => {
    const foreign = new Sequelize(database.databaseUrl, { logging: false });
    try {
      await foreign.transaction(async (transaction) => {
        const [ownerRows] = await foreign.query(
          "SELECT pg_backend_pid() AS backend, txid_current()::text AS transaction_id",
          { transaction, type: QueryTypes.RAW, raw: true },
        );
        expect(
          await rawQuery(
            "SELECT pg_backend_pid() AS backend, txid_current()::text AS transaction_id",
            [],
            transaction,
          ),
        ).toEqual(ownerRows);
      });
    } finally {
      await foreign.close();
    }
  });
});
