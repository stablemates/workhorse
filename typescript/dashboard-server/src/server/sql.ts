import {
  connectionPoolOf,
  databaseErrorCode,
  rowsToQueryResult,
  type Queryable,
} from "@stablemates/workhorse";

/**
 * One parameterized SQL fragment.
 *
 * @internal This package builds every dashboard query itself, so no consumer constructs a
 * fragment: `dashboardDatabase` returns the `DashboardDatabase` that `createDashboardHost` takes.
 * The type stays exported only so this package's own modules can name a fragment they return.
 */
export interface DashboardSql {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * The mark the tag puts on the fragments it builds, and the only thing it splices as SQL on.
 *
 * A structural test would accept any object carrying `text` and `values`, so a procedure input that
 * admitted a free-form object could reach a read as a value and be spliced rather than bound. This
 * symbol is module-private and unregistered, so nothing outside this file can produce a value that
 * carries it, and everything else the tag receives becomes a bind parameter.
 */
const FRAGMENT = Symbol("workhorse.dashboard-server.sql");

interface BrandedSql extends DashboardSql {
  readonly [FRAGMENT]: true;
}

function brand(text: string, values: readonly unknown[]): BrandedSql {
  return { [FRAGMENT]: true, text, values };
}

function isDashboardSql(value: unknown): value is DashboardSql {
  return typeof value === "object" && value !== null && FRAGMENT in value;
}

function appendFragment(parts: string[], values: unknown[], fragment: DashboardSql): void {
  parts.push(
    fragment.text.replaceAll(/\$(\d+)/g, (_, index: string) => `$${values.length + Number(index)}`),
  );
  values.push(...fragment.values);
}

interface DashboardSqlTag {
  (strings: TemplateStringsArray, ...parameters: unknown[]): DashboardSql;
  join(fragments: readonly DashboardSql[], separator: DashboardSql): DashboardSql;
}

export const sql: DashboardSqlTag = Object.assign(
  (strings: TemplateStringsArray, ...parameters: unknown[]): DashboardSql => {
    const parts: string[] = [];
    const values: unknown[] = [];
    for (const [index, text] of strings.entries()) {
      parts.push(text);
      if (index >= parameters.length) continue;
      const parameter = parameters[index];
      if (isDashboardSql(parameter)) appendFragment(parts, values, parameter);
      else {
        values.push(parameter);
        parts.push(`$${values.length}`);
      }
    }
    return brand(parts.join(""), values);
  },
  {
    join(fragments: readonly DashboardSql[], separator: DashboardSql): DashboardSql {
      const parts: string[] = [];
      const values: unknown[] = [];
      for (const [index, fragment] of fragments.entries()) {
        if (index > 0) appendFragment(parts, values, separator);
        appendFragment(parts, values, fragment);
      }
      return brand(parts.join(""), values);
    },
  },
);

export interface DashboardDatabase {
  execute<Row extends Record<string, unknown>>(query: DashboardSql): Promise<{ rows: Row[] }>;
}

/**
 * How long one dashboard read may run before PostgreSQL cancels it.
 *
 * An operator who opens a page waits seconds, not minutes, and a read nobody is still waiting for
 * is a connection the embedding application has lost. Every dashboard read is a bounded projection,
 * so one that runs this long is evidence of a problem rather than of an expensive but useful
 * answer.
 */
export const DASHBOARD_STATEMENT_TIMEOUT_MS = 15_000;

/** PostgreSQL reports a statement it cancelled for exceeding `statement_timeout` with this SQLSTATE. */
const QUERY_CANCELED = "57014";

/**
 * One dashboard read ran past its bound and PostgreSQL cancelled it.
 *
 * The connection is already back: this names a read that was refused, not one still running. The
 * router turns it into a typed RPC error, so an operator sees a page that says it timed out rather
 * than one that never answers.
 */
export class DashboardReadTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(`Dashboard read exceeded its ${timeoutMs}ms bound`, options);
    this.name = "DashboardReadTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** A connection lent for the length of one transaction, as node-postgres pools lend one. */
interface LentClient extends Queryable {
  release(error?: unknown): void;
}

function asLentClient(value: unknown): LentClient | undefined {
  const candidate = value as Partial<LentClient> | null | undefined;
  return typeof candidate?.query === "function" && typeof candidate.release === "function"
    ? (candidate as LentClient)
    : undefined;
}

/**
 * Wrap a caller's connection as the read surface every dashboard procedure is given.
 *
 * Each read runs inside its own read-only transaction with a transaction-local
 * `statement_timeout`, so one expensive page cannot hold a connection of the embedding
 * application's pool indefinitely. The bound has to be set on the connection rather than inside the
 * procedure: PostgreSQL arms the statement timer when the statement starts, so a function that sets
 * the value while it runs never bounds its own execution.
 *
 * Bounding a read needs a connection held across several statements, which only a pool can lend.
 * The pool is the one Workhorse itself resolves for a worker: the database when it has `connect()`,
 * or the pool an ORM adapter attached to it. An adapter that attaches a pool lazily may only reach
 * it once its ORM connects, so the pool is resolved again for each read.
 *
 * A `Queryable` with neither is read directly and unbounded, because issuing `BEGIN` and the read
 * separately through one shared entry point could leave a stranger's connection inside a
 * transaction.
 */
export function dashboardDatabase(
  database: Queryable,
  timeoutMs = DASHBOARD_STATEMENT_TIMEOUT_MS,
): DashboardDatabase {
  return {
    async execute<Row extends Record<string, unknown>>(query: DashboardSql) {
      const pool = connectionPoolOf(database);
      if (!pool) {
        const result = await database.query<Row>(query.text, query.values);
        return { rows: result.rows };
      }
      const client = asLentClient(await pool.connect());
      if (!client) throw new TypeError("Database connect() did not return a releasable client");
      try {
        // READ ONLY is a second, cheaper guard: a dashboard read has no business writing, and a
        // procedure that tried would be refused by PostgreSQL rather than by review.
        await client.query("BEGIN READ ONLY");
        // set_config takes the bound as a parameter, so the value never enters statement text.
        await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
        const result = await client.query<Row>(query.text, query.values);
        await client.query("COMMIT");
        return { rows: result.rows };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (databaseErrorCode(error) === QUERY_CANCELED) {
          throw new DashboardReadTimeoutError(timeoutMs, { cause: error });
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Present the bounded read surface as a `Queryable`, so a core read runs under the same bound.
 *
 * The retention preview is computed by `Admin`, which reads through a `Queryable`. Handing it the
 * caller's connection directly would run that preview with no read-only transaction and no timeout.
 */
export function boundedQueryable(database: DashboardDatabase): Queryable {
  return {
    async query(text: string, values: readonly unknown[] = []) {
      const { rows } = await database.execute({ text, values });
      return rowsToQueryResult(rows) as never;
    },
  };
}
