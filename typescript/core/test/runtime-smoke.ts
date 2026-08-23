/**
 * Prove the built runtime completes an enqueue → claim → complete round-trip on the JS runtime
 * executing this script. CI runs it under Bun and Deno, whose lanes exist to catch driver and
 * timer regressions the Node-only vitest suites cannot see; `docs/compatibility.md` records what
 * each lane does and does not claim.
 *
 * The script deliberately imports the built `dist` entry point rather than the TypeScript
 * sources: it validates what a consumer installs, and it keeps the module graph plain ESM so no
 * runtime needs source-resolution flags to load it.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Pool } from "pg";
import { Admin, installSchema, Queue, Worker } from "../dist/src/index.js";

declare const Bun: { version: string } | undefined;
declare const Deno: { version: { deno: string } } | undefined;

const runtime =
  typeof Bun !== "undefined"
    ? { name: "bun", version: Bun.version }
    : typeof Deno !== "undefined"
      ? { name: "deno", version: Deno.version.deno }
      : { name: "node", version: process.versions.node };

const testDatabaseUrl = process.env.WORKHORSE_TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("WORKHORSE_TEST_DATABASE_URL is required");

// A dedicated database per runtime keeps concurrent lanes and the vitest suites out of each
// other's way, and its name keeps the `test` suffix rule of local-database.ts visible to operators.
const adminUrl = new URL(testDatabaseUrl);
const smokeDatabase = `${decodeURIComponent(adminUrl.pathname.slice(1))}_smoke_${runtime.name}`;

const adminDatabase = new Client({ connectionString: testDatabaseUrl });
await adminDatabase.connect();
await adminDatabase.query(`DROP DATABASE IF EXISTS "${smokeDatabase}"`);
await adminDatabase.query(`CREATE DATABASE "${smokeDatabase}"`);
await adminDatabase.end();

const smokeUrl = new URL(testDatabaseUrl);
smokeUrl.pathname = `/${smokeDatabase}`;
const pool = new Pool({ connectionString: smokeUrl.href, max: 4 });

try {
  await installSchema(pool);

  const queue = new Queue(pool);
  const workhorseAdmin = new Admin(pool);
  const payload = { runtime: runtime.name, sentinel: "runtime-smoke" };
  const worker = new Worker(queue, {
    queue: "runtime-smoke",
    workerId: `runtime-smoke-${runtime.name}`,
    pollMs: 10,
  }).handle("smoke.echo", async (received) => ({ echoed: received }));

  const jobId = await queue.enqueue("smoke.echo", payload, { queue: "runtime-smoke" });

  let state = "pending";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await worker.runOnce();
    const snapshot = await workhorseAdmin.getJob(jobId);
    state = snapshot?.state ?? "missing";
    if (state === "succeeded") {
      const echoed = (snapshot?.result as { echoed?: unknown } | null)?.echoed;
      if (JSON.stringify(echoed) !== JSON.stringify(payload)) {
        throw new Error(`Job succeeded with the wrong result: ${JSON.stringify(snapshot?.result)}`);
      }
      break;
    }
    if (state === "failed" || state === "canceled") {
      throw new Error(`Job finished in ${state} state`);
    }
    await sleep(20);
  }
  if (state !== "succeeded") throw new Error(`Job did not complete; final state was ${state}`);

  console.log(JSON.stringify({ ok: true, runtime, jobId, state }));
} finally {
  await pool.end();
  const cleanup = new Client({ connectionString: testDatabaseUrl });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS "${smokeDatabase}"`);
  await cleanup.end();
}
