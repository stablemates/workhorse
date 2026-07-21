#!/usr/bin/env node
import { Pool } from "pg";
import {
  assertLocalDatabasePurpose,
  databaseName,
  isLocalDatabasePurpose,
  localDatabaseUrl,
} from "../local-database.js";
import { installSchema } from "../schema.js";

// This command is intentionally harder to invoke than normal development commands because it
// terminates connections and drops a database. Keep every guard when extending it.
if (!process.argv.includes("--yes")) throw new Error("Pass --yes to confirm the destructive reset");
const purposeIndex = process.argv.indexOf("--database");
const purpose = purposeIndex === -1 ? undefined : process.argv[purposeIndex + 1];
if (!purpose || !isLocalDatabasePurpose(purpose)) {
  throw new Error("Pass --database dev, --database test, or --database bench");
}

const databaseUrl = localDatabaseUrl(purpose);
const target = new URL(databaseUrl);
const targetDatabaseName = databaseName(databaseUrl);
assertLocalDatabasePurpose(databaseUrl, purpose);
if (
  target.hostname !== "localhost" &&
  target.hostname !== "127.0.0.1" &&
  target.hostname !== "::1" &&
  process.env.IRONSHIFT_ALLOW_REMOTE_RESET !== "1"
) {
  throw new Error("Refusing to reset a remote database without IRONSHIFT_ALLOW_REMOTE_RESET=1");
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
console.log(
  `Reset ${purpose} target: ${target.username}@${target.hostname}:${target.port || "5432"}/${targetDatabaseName}`,
);
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
try {
  // FORCE terminates other sessions. The purpose suffix, confirmation, and host guard above are
  // the safety boundary around this destructive operation.
  await admin.query(`DROP DATABASE IF EXISTS ${identifier(targetDatabaseName)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${identifier(targetDatabaseName)}`);
} finally {
  await admin.end();
}

const database = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  await installSchema(database);
  console.log(`Reset ${targetDatabaseName} and installed sql/schema.sql`);
} finally {
  await database.end();
}
