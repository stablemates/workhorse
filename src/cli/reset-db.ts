#!/usr/bin/env node
import { Pool } from "pg";
import { installSchema } from "../schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!process.argv.includes("--yes")) throw new Error("Pass --yes to confirm the destructive reset");
const target = new URL(databaseUrl);
const databaseName = decodeURIComponent(target.pathname.slice(1));

if (!databaseName.endsWith("_test")) {
  throw new Error(
    `Refusing to reset database ${JSON.stringify(databaseName)} because its name does not end in _test`,
  );
}
if (!databaseName) throw new Error("DATABASE_URL must include a database name");
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
  `Reset target: ${target.username}@${target.hostname}:${target.port || "5432"}/${databaseName}`,
);
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
try {
  await admin.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${identifier(databaseName)}`);
} finally {
  await admin.end();
}

const database = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  await installSchema(database);
  console.log(`Reset ${databaseName} and installed sql/schema.sql`);
} finally {
  await database.end();
}
