import { setTimeout as delay } from "node:timers/promises";
import { isMissingDatabaseRelationError, SchemaCompatibilityError } from "@stablemates/workhorse";

const SCHEMA_RETRY_MS = 500;

export interface ApplicationSchemaOperations {
  assertCompatible(): Promise<void>;
  assertDemoCompatible(): Promise<void>;
  install(): Promise<void>;
  installDemo(): Promise<void>;
}

export interface SchemaPreparationOperations {
  readVersion(): Promise<number | null>;
  install(): Promise<void>;
  migrate(): Promise<void>;
  installDemo(): Promise<void>;
}

/** Keep schema writes in development and make production application startup read-only. */
export async function prepareApplicationSchema(
  mode: "development" | "production",
  operations: ApplicationSchemaOperations,
): Promise<void> {
  if (mode === "production") {
    await operations.assertCompatible();
    await operations.assertDemoCompatible();
    return;
  }

  try {
    await operations.assertCompatible();
  } catch (error) {
    if (!isMissingDatabaseRelationError(error)) throw error;
    await operations.install();
  }
  await operations.installDemo();
}

/**
 * Hold a development worker until the demo server has installed the Workhorse schema.
 *
 * The launcher starts the server and every worker at once, and only the development server installs
 * the schema. Every other refusal fails at once. Production keeps a read-only startup, so a missing
 * schema fails at once there too.
 */
export async function awaitWorkerSchema(
  mode: "development" | "production",
  assertCompatible: () => Promise<void>,
  onWait: () => void,
  retryMs = SCHEMA_RETRY_MS,
): Promise<void> {
  for (let waiting = false; ; waiting = true) {
    try {
      await assertCompatible();
      return;
    } catch (error) {
      const missing =
        error instanceof SchemaCompatibilityError && error.code === "schema-not-installed";
      if (mode === "production" || !missing) throw error;
    }
    if (!waiting) onWait();
    await delay(retryMs);
  }
}

/** Prepare both the Workhorse runtime schema and the demo application's own tables. */
export async function prepareSchema(
  operations: SchemaPreparationOperations,
): Promise<"installed" | "migrated"> {
  try {
    await operations.readVersion();
  } catch (error) {
    if (!isMissingDatabaseRelationError(error)) throw error;
    await operations.install();
    await operations.installDemo();
    return "installed";
  }

  await operations.migrate();
  await operations.installDemo();
  return "migrated";
}
