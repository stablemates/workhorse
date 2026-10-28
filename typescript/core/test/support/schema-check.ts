import type { QueryResult } from "pg";
import { SQL_STATEMENTS } from "../../src/queue/sql-catalogue.generated.js";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "../../src/schema.js";
import type { Queryable } from "../../src/types.js";

const COMPATIBILITY = SQL_STATEMENTS["compatibility_state"];

/**
 * Let a fake database answer the compatibility check of `Queue` and `Admin` with the schema this
 * build installs. The fake keeps its identity and its other properties. Every other statement
 * reaches the fake's own `query`, so the statements the fake records do not change.
 */
export function answerSchemaCheck<T extends Queryable>(database: T): T {
  const query = database.query;
  database.query = function (this: T, text: string, values?: readonly unknown[]) {
    if (text === COMPATIBILITY) {
      return Promise.resolve({
        rows: [
          { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
          { kind: "protocol", version: PROTOCOL_VERSION },
        ],
        rowCount: 2,
        command: "SELECT",
        oid: 0,
        fields: [],
      } as QueryResult);
    }
    return query.call(this, text, values);
  } as T["query"];
  return database;
}
