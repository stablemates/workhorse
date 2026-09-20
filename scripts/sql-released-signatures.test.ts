import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findSignatureDrift,
  readSignatureSources,
  type SignatureSource,
} from "./sql-released-signatures.js";

const repository = path.resolve(import.meta.dirname, "..");

/** The released baseline every case below replaces from, reduced to the one function it checks. */
const released: SignatureSource = {
  kind: "release",
  version: 1,
  file: "sql/releases/0001.sql",
  source: `CREATE OR REPLACE FUNCTION workhorse.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer
) RETURNS TABLE (task_id uuid, fence_token bigint)
LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::bigint $$;`,
};

function migration(body: string, version = 2): SignatureSource {
  return { kind: "migration", version, file: `sql/migrations/000${version}-probe.sql`, source: body };
}

describe("released function signatures", () => {
  it("accepts a migration that replaces a released function's body", () => {
    const replaced = migration(`CREATE OR REPLACE FUNCTION workhorse.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer
) RETURNS TABLE (task_id uuid, fence_token bigint)
LANGUAGE sql AS $$ SELECT gen_random_uuid(), 1::bigint $$;`);

    expect(findSignatureDrift([released, replaced])).toEqual([]);
  });

  it("refuses a migration that adds an argument to a released function", () => {
    const widened = migration(`CREATE OR REPLACE FUNCTION workhorse.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer
) RETURNS TABLE (task_id uuid, fence_token bigint, attempt integer)
LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::bigint, NULL::integer $$;`);

    expect(findSignatureDrift([released, widened])).toEqual([
      {
        file: "sql/migrations/0002-probe.sql",
        function: "claim_v1",
        released:
          "(p_queue_name text, p_worker_id text, p_lease_ms integer) RETURNS table(task_id uuid, fence_token bigint)",
        redefined:
          "(p_queue_name text, p_worker_id text, p_lease_ms integer) RETURNS table(task_id uuid, fence_token bigint, attempt integer)",
        releasedBy: "sql/releases/0001.sql",
      },
    ]);
  });

  it("refuses a migration that retypes a released function's argument", () => {
    const retyped = migration(`CREATE OR REPLACE FUNCTION workhorse.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms bigint
) RETURNS TABLE (task_id uuid, fence_token bigint)
LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::bigint $$;`);

    expect(findSignatureDrift([released, retyped]).map((drift) => drift.function)).toEqual([
      "claim_v1",
    ]);
  });

  it("reads a later artifact as the shipped signature rather than an offender", () => {
    // A frozen artifact restates the installation its release shipped. Only a migration changes
    // one, so the artifact refreshes what is shipped and never reports itself.
    const artifact: SignatureSource = {
      kind: "release",
      version: 2,
      file: "sql/releases/0002.sql",
      source: `CREATE OR REPLACE FUNCTION workhorse.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer,
  p_batch_size integer
) RETURNS TABLE (task_id uuid, fence_token bigint)
LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::bigint $$;`,
    };

    expect(findSignatureDrift([released, artifact])).toEqual([]);
  });

  it("accepts an overload that differs from its sibling's argument count", () => {
    // `claim_v1(text, text, integer)` and a four-argument overload are separate functions, so a
    // caller of either keeps its own binding.
    const overload = migration(`CREATE OR REPLACE FUNCTION workhorse.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer,
  p_batch_size integer
) RETURNS TABLE (task_id uuid, fence_token bigint)
LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::bigint $$;`);

    expect(findSignatureDrift([released, overload])).toEqual([]);
  });

  it("finds no drift in the released migration chain", async () => {
    expect(findSignatureDrift(await readSignatureSources(repository))).toEqual([]);
  });
});
