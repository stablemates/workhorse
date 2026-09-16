#!/usr/bin/env node
/**
 * Drop the scratch test databases a timed-out teardown abandoned and the schema templates a
 * schema change or a new UTC day retired. Dropping a database is destructive, so this command
 * mirrors `reset-db.ts`: without `--yes` it prints the plan and changes nothing.
 */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { localDatabaseUrl } from "../typescript/core/src/local-database.js";
import { schemaTemplateName } from "../typescript/core/test/support/schema-template.js";
import {
  assertSweepTarget,
  checkoutDatabaseNames,
  dropRetiredDatabases,
  formatBytes,
  planTestDatabaseSweep,
  readDatabaseInventory,
  registryDatabaseNames,
  type SweepContext,
  type SweepEntry,
  testFamilyRoots,
} from "./test-database-sweep.js";
import { worktreeContext } from "./worktree-resources.js";

const confirmed = process.argv.includes("--yes");
const sourceUrl = localDatabaseUrl("test");
assertSweepTarget(sourceUrl);

const context = worktreeContext();
const protectedNames = new Set([
  ...checkoutDatabaseNames(process.env),
  ...checkoutDatabaseNames({}),
  ...(await registryDatabaseNames(context.commonGitDirectory)),
]);
const schema = await readFile(new URL("../sql/schema/current.sql", import.meta.url));
const sweepContext: SweepContext = {
  protectedNames,
  familyRoots: testFamilyRoots(protectedNames),
  currentTemplate: schemaTemplateName(schema),
};

const target = new URL(sourceUrl);
console.log(
  `Sweep target: ${target.username}@${target.hostname}:${target.port || "5432"}, test families ${[...sweepContext.familyRoots].toSorted().join(", ")}`,
);
console.log(`Keeping the current schema template ${sweepContext.currentTemplate}`);

const admin = new Pool({ connectionString: adminUrl(sourceUrl), max: 1 });
try {
  const plan = planTestDatabaseSweep(await readDatabaseInventory(admin), sweepContext);
  if (plan.drop.length === 0) {
    console.log("No retired test database to sweep");
  } else if (confirmed) {
    const outcome = await dropRetiredDatabases(admin, plan, sweepContext);
    for (const entry of outcome.dropped) {
      console.log(`Dropped ${entry.kind} database ${entry.name} (${formatBytes(entry.sizeBytes)})`);
    }
    console.log(
      `Dropped ${outcome.dropped.length} database(s), reclaiming ${formatBytes(totalBytes(outcome.dropped))}`,
    );
    report("claimed by a session since the plan was made", outcome.skipped);
  } else {
    for (const entry of plan.drop) {
      console.log(
        `Would drop ${entry.kind} database ${entry.name} (${formatBytes(entry.sizeBytes)})`,
      );
    }
    console.log(
      `Would drop ${plan.drop.length} database(s), reclaiming ${formatBytes(totalBytes(plan.drop))}. Pass --yes to drop them.`,
    );
  }
  report("in use and left alone", plan.held);
} finally {
  await admin.end();
}

function report(reason: string, entries: readonly SweepEntry[]): void {
  if (entries.length === 0) return;
  const names = entries.map((entry) => entry.name).join(", ");
  console.log(`${entries.length} retired database(s) ${reason}: ${names}`);
}

function totalBytes(entries: readonly SweepEntry[]): number {
  return entries.reduce((total, entry) => total + entry.sizeBytes, 0);
}

function adminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
