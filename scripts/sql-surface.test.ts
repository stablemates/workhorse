import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSqlSchema } from "./sql-surface.js";
import {
  classifyGovernedSurface,
  deriveGovernedSurface,
  mergeGovernedSurface,
  readSurfaceSources,
  type GovernedSurface,
} from "./sql-governed-surface.js";

const repository = path.resolve(import.meta.dirname, "..");

const schemaText = await readFile(path.join(repository, "sql/schema/current.sql"), "utf8");
const schema = parseSqlSchema(schemaText);

function surface(overrides: Partial<GovernedSurface> = {}): GovernedSurface {
  return {
    formatVersion: 1,
    functions: {},
    relations: {},
    internalHelpers: { functions: [], relations: [] },
    ...overrides,
  };
}

describe("parsing the installed schema", () => {
  it("reads a function's argument types, defaults, and table result", () => {
    expect(schema.functions.get("claim_v1")?.[0]).toMatchObject({
      arguments: [
        { name: "p_queue_name", type: "text", optional: false },
        { name: "p_worker_id", type: "text", optional: false },
        { name: "p_lease_ms", type: "integer", optional: true },
      ],
    });
    expect(schema.functions.get("claim_v1")?.[0]?.returns).toContain("fence_token bigint");
  });

  it("reads a view's projected columns and resolves their types through the table", () => {
    expect([...(schema.relations.get("dashboard_queue_control_v1")?.columns ?? [])]).toEqual([
      ["queue_name", "text"],
      ["paused", "boolean"],
      ["tier", "text"],
      ["record_attempts", "boolean"],
      ["record_claims", "boolean"],
    ]);
  });

  it("resolves a projected function call to the function's return type", () => {
    expect(schema.relations.get("dashboard_task_v1")?.columns.get("payload")).toBe("jsonb");
  });

  it("copies the column list a LIKE clause inherits", () => {
    expect(schema.relations.get("task_stat_bucket_day")?.columns).toEqual(
      schema.relations.get("task_stat_bucket_hour")?.columns,
    );
  });

  it("ignores the CREATE TABLE statements that only run inside a function body", () => {
    expect(schemaText).toContain("CREATE TABLE workhorse.%I PARTITION OF workhorse.task_event");
    expect([...schema.relations.keys()].filter((name) => name.includes("%"))).toEqual([]);
  });

  it("resolves every governed view column to a declared type", () => {
    const unresolved = [...schema.relations.values()]
      .filter((relation) => relation.kind === "view")
      .flatMap((relation) =>
        [...relation.columns]
          .filter(([, type]) => type === "unknown")
          .map(([column]) => `${relation.name}.${column}`),
      );
    expect(unresolved).toEqual([]);
  });
});

describe("deriving the governed set", () => {
  const derived = deriveGovernedSurface(schema, [
    { filename: "reader.sql", text: "SELECT paused FROM workhorse.queue_control" },
  ]);

  it("governs a relation a reader names, and only the columns that reader mentions", () => {
    expect(derived.relations.queue_control).toEqual({
      kind: "table",
      columns: { paused: "boolean" },
    });
  });

  it("governs every column of a published dashboard view without any reader", () => {
    expect(derived.relations.dashboard_queue_control_v1?.columns).toEqual({
      paused: "boolean",
      queue_name: "text",
      record_attempts: "boolean",
      record_claims: "boolean",
      tier: "text",
    });
  });

  it("keeps governing a relation and its columns that only a released client reads", () => {
    const retained = deriveGovernedSurface(schema, [], [], {
      task_event: { kind: "table", columns: { occurred_at: "timestamptz" } },
      no_such_relation: { kind: "table", columns: { id: "uuid" } },
    });
    expect(retained.relations.task_event).toEqual({
      kind: "table",
      columns: { occurred_at: "timestamptz" },
    });
    expect(retained.relations.no_such_relation).toBeUndefined();
  });

  it("records what no supported release reads as an internal helper", () => {
    expect(derived.internalHelpers.functions).toContain("uuid_v7_v1");
    expect(derived.internalHelpers.relations).toContain("schema_migration");
    expect(derived.internalHelpers.functions).not.toContain("dashboard_task_result_v1");
  });
});

describe("classifying a governed SQL change", () => {
  const promised = surface({
    functions: {
      purge_queue_v1: { arguments: ["text", "integer?"], returns: "integer" },
      list_tasks_v1: {
        arguments: ["jsonb"],
        returns: "table",
        returnsColumns: { task_id: "uuid", state: "text" },
      },
    },
    relations: { dashboard_queue_control_v1: { kind: "view", columns: { paused: "boolean" } } },
  });

  it("passes an addition", () => {
    const current = mergeGovernedSurface(
      promised,
      surface({
        functions: {
          ...promised.functions,
          redrive_v2: { arguments: ["uuid"], returns: "boolean" },
          purge_queue_v1: { arguments: ["text", "integer?", "boolean?"], returns: "integer" },
        },
        relations: {
          dashboard_queue_control_v1: {
            kind: "view",
            columns: { paused: "boolean", queue_name: "text" },
          },
        },
      }),
    );
    expect(classifyGovernedSurface(promised, current)).toEqual([]);
  });

  it("names a removed function", () => {
    const current = surface({ functions: {}, relations: promised.relations });
    expect(classifyGovernedSurface(promised, current)).toContainEqual({
      classification: "breaking",
      subject: "function workhorse.purge_queue_v1",
      change: "removed",
    });
  });

  it("names a retyped argument and an argument that lost its default", () => {
    const current = surface({
      functions: {
        ...promised.functions,
        purge_queue_v1: { arguments: ["uuid", "integer"], returns: "integer" },
      },
    });
    const findings = classifyGovernedSurface(promised, current).map((finding) => finding.change);
    expect(findings).toContain("argument 1 changed from text to uuid");
  });

  it("names an argument that stops accepting the shorter call", () => {
    const current = surface({
      functions: {
        ...promised.functions,
        purge_queue_v1: { arguments: ["text", "integer"], returns: "integer" },
      },
    });
    expect(classifyGovernedSurface(promised, current)).toContainEqual({
      classification: "breaking",
      subject: "function workhorse.purge_queue_v1",
      change: "argument 2 (integer) lost its default",
    });
  });

  it("names a removed or retyped result column", () => {
    const current = surface({
      functions: {
        ...promised.functions,
        list_tasks_v1: {
          arguments: ["jsonb"],
          returns: "table",
          returnsColumns: { task_id: "text" },
        },
      },
    });
    const changes = classifyGovernedSurface(promised, current).map((finding) => finding.change);
    expect(changes).toContain("output column task_id changed from uuid to text");
    expect(changes).toContain("output column state was removed");
  });

  it("names a removed view column", () => {
    const current = surface({
      functions: promised.functions,
      relations: { dashboard_queue_control_v1: { kind: "view", columns: {} } },
    });
    expect(classifyGovernedSurface(promised, current)).toContainEqual({
      classification: "breaking",
      subject: "view workhorse.dashboard_queue_control_v1",
      change: "column paused was removed",
    });
  });

  it("keeps a promise the current schema dropped, so the next check still reports it", () => {
    const merged = mergeGovernedSurface(promised, surface({ relations: promised.relations }));
    expect(merged.functions.purge_queue_v1).toEqual(promised.functions.purge_queue_v1);
  });
});

it("promises every governed function and column the installed schema still provides", async () => {
  const promised = JSON.parse(
    await readFile(path.join(repository, "protocol/v1/governed-surface.json"), "utf8"),
  ) as GovernedSurface;
  const current = deriveGovernedSurface(
    schema,
    await readSurfaceSources(repository),
    Object.keys(promised.functions),
    promised.relations,
  );
  expect(classifyGovernedSurface(promised, current)).toEqual([]);
  expect(
    mergeGovernedSurface(promised, current),
    "protocol/v1/governed-surface.json is stale; run pnpm sql-catalogues:generate",
  ).toEqual(promised);
});

const committedSources = await readSurfaceSources(repository);
const committedPromise = JSON.parse(
  await readFile(path.join(repository, "protocol/v1/governed-surface.json"), "utf8"),
) as GovernedSurface;

describe("a default value or a row-type field that the schema changes (SM-2047)", () => {
  const sources = committedSources;
  const promised = committedPromise;

  /** Classify a copy of the installed schema with one text replaced, against the committed promise. */
  function classifyEdited(before: string, after: string): string[] {
    expect(schemaText.split(before)).toHaveLength(2);
    const edited = parseSqlSchema(schemaText.replace(before, after));
    const current = deriveGovernedSurface(
      edited,
      sources,
      Object.keys(promised.functions),
      promised.relations,
    );
    return classifyGovernedSurface(promised, current).map(
      (finding) => `${finding.subject} ${finding.change}`,
    );
  }

  const claimLease = [
    "CREATE OR REPLACE FUNCTION workhorse.claim_v1(",
    "  p_queue_name text,",
    "  p_worker_id text,",
    "  p_lease_ms integer DEFAULT 30000",
    ")",
  ].join("\n");

  it("records the value of each default", () => {
    expect(promised.functions.claim_v1?.defaults).toEqual({ "3": "30000" });
  });

  it("names a changed default value", () => {
    expect(classifyEdited(claimLease, claimLease.replace("30000", "60000"))).toEqual([
      "function workhorse.claim_v1 argument 3 default changed from 30000 to 60000",
    ]);
  });

  it("names a changed argument name, and accepts a new function version", () => {
    expect(promised.functions.claim_v1?.argumentNames).toEqual([
      "p_queue_name",
      "p_worker_id",
      "p_lease_ms",
    ]);
    expect(classifyEdited(claimLease, claimLease.replace("p_lease_ms", "p_lease"))).toEqual([
      "function workhorse.claim_v1 argument 3 name changed from p_lease_ms to p_lease",
    ]);
    // A successor is a new function with its own names, so it only adds to the promise.
    const successor =
      "CREATE FUNCTION workhorse.claim_v9(p_queue text, p_lease integer DEFAULT 1)" +
      " RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;\n";
    expect(classifyEdited(claimLease, `${successor}${claimLease}`)).toEqual([]);
  });

  it("accepts a new argument with a default", () => {
    const added = claimLease.replace("30000\n)", "30000,\n  p_extra text DEFAULT NULL\n)");
    expect(classifyEdited(claimLease, added)).toEqual([]);
  });

  it("accepts a default that only changes layout or keyword case", () => {
    const contract = "p_task_type text, p_version text DEFAULT NULL\n) RETURNS SETOF";
    expect(
      classifyEdited(contract, "p_task_type text, p_version text DEFAULT   null\n) RETURNS SETOF"),
    ).toEqual([]);
  });

  const definitionHead =
    "CREATE TABLE IF NOT EXISTS workhorse.contract_definition (\n  task_type text NOT NULL";

  it("records the fields of a row type that a governed function returns", () => {
    expect(promised.functions.get_contract_definition_v1?.returnsColumns).toMatchObject({
      payload_max_bytes: "integer",
      payload_redact_keys: "text[]",
    });
    expect(promised.functions.get_retention_policy_v1?.returnsColumns).toBeDefined();
    expect(promised.functions.get_maintenance_policy_v1?.returnsColumns).toBeDefined();
  });

  it("names a retyped or removed field of a returned row type", () => {
    expect(classifyEdited(definitionHead, definitionHead.replace("text", "varchar"))).toContain(
      "function workhorse.get_contract_definition_v1 output column task_type changed from text to varchar",
    );
    expect(classifyEdited(definitionHead, definitionHead.replace("task_type", "kind"))).toContain(
      "function workhorse.get_contract_definition_v1 output column task_type was removed",
    );
  });

  const definitionTail =
    "  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),\n  PRIMARY KEY (task_type, version)\n);";

  it("accepts a new field after the fields of a returned row type", () => {
    const added = definitionTail.replace("\n  PRIMARY", "\n  added_field text,\n  PRIMARY");
    expect(classifyEdited(definitionTail, added)).toEqual([]);
  });

  it("names a reordered result, or a new field before the promised ones", () => {
    const swapped = definitionHead.replace(
      "task_type text NOT NULL",
      "version text NOT NULL,\n  task_type text NOT NULL",
    );
    const reordered = classifyEdited(
      `${definitionHead} CHECK (task_type <> ''),\n  version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),`,
      `${swapped} CHECK (task_type <> ''),`,
    );
    expect(reordered).toContain(
      "function workhorse.get_contract_definition_v1 output column 1 changed from task_type to version",
    );
    const inserted = definitionHead.replace("(\n", "(\n  added_field text,\n");
    expect(classifyEdited(definitionHead, inserted)).toContain(
      "function workhorse.get_contract_definition_v1 output column 1 changed from task_type to added_field",
    );
  });
});

function defaultOf(argument: string): string | undefined {
  const parsed = parseSqlSchema(
    `CREATE FUNCTION workhorse.sample_v1(${argument}) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;`,
  );
  return parsed.functions.get("sample_v1")?.[0]?.arguments[0]?.default;
}
describe("reading a default expression", () => {
  it("keeps the case and spacing inside a string or dollar-quoted literal", () => {
    expect(defaultOf("p text DEFAULT $$ABC$$")).toBe("$$ABC$$");
    expect(defaultOf("p text DEFAULT $$ABC$$")).not.toBe(defaultOf("p text DEFAULT $$abc$$"));
    expect(defaultOf("p text DEFAULT 'a  B'")).toBe("'a  B'");
  });

  it("splits at the first DEFAULT outside a literal", () => {
    expect(defaultOf("p text DEFAULT 'a default b'")).toBe("'a default b'");
    expect(defaultOf("p text DEFAULT 'a default b'")).not.toBe(
      defaultOf("p text DEFAULT 'a DEFAULT b'"),
    );
  });

  it("reads the = form as the same default", () => {
    expect(defaultOf("p integer = 30000")).toBe(defaultOf("p integer DEFAULT 30000"));
  });

  it("gives the same value for a change of layout or keyword case", () => {
    expect(defaultOf("p timestamptz DEFAULT CLOCK_TIMESTAMP()  -  INTERVAL '1 day'")).toBe(
      "clock_timestamp()-interval'1 day'",
    );
    expect(defaultOf("p timestamptz DEFAULT clock_timestamp()-interval '1 day'")).toBe(
      defaultOf("p timestamptz DEFAULT clock_timestamp() - interval '1 day'"),
    );
    expect(defaultOf("p jsonb DEFAULT '{}' :: jsonb")).toBe(
      defaultOf("p jsonb DEFAULT '{}'::jsonb"),
    );
  });

  it("keeps a comment marker inside a string literal", () => {
    expect(defaultOf("p text DEFAULT 'a--b'\n")).toBe("'a--b'");
    expect(defaultOf("p text DEFAULT 'a--b'\n")).not.toBe(defaultOf("p text DEFAULT 'a--c'\n"));
  });

  it("gives the same value for a comment or for parentheses around the whole default", () => {
    const plain = defaultOf("p integer DEFAULT 30000");
    expect(defaultOf("p integer DEFAULT 30000 /* milliseconds */")).toBe(plain);
    expect(defaultOf("p integer DEFAULT (30000)")).toBe(plain);
    expect(defaultOf("p integer DEFAULT ((30000))")).toBe(plain);
    expect(defaultOf("p integer DEFAULT (1) + (2)")).toBe("(1)+(2)");
    expect(defaultOf("p text DEFAULT '/* kept */'")).toBe("'/* kept */'");
  });

  it("keeps a parenthesis inside a string literal", () => {
    expect(defaultOf("p text DEFAULT 'a)b'")).toBe("'a)b'");
    expect(defaultOf("p text DEFAULT 'a)b'")).not.toBe(defaultOf("p text DEFAULT 'a)c'"));
  });

  it("keeps a comma inside a string literal", () => {
    expect(defaultOf("p text DEFAULT 'a,b'")).toBe("'a,b'");
    expect(defaultOf("p text DEFAULT 'a,b'")).not.toBe(defaultOf("p text DEFAULT 'a,c'"));
  });
});
